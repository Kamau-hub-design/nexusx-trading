const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const port = Number(process.env.PORT) || 3000;
const projectRoot = path.join(__dirname, '..');
const dataDirectory = path.join(projectRoot, 'data');
const dataFile = path.join(dataDirectory, 'nexusx.json');
const sessions = new Map();

require('dotenv').config();

const database = require('./database');
const daraja = require('./daraja');
const nodemailer = require('nodemailer');
const verificationCodes = new Map();

const mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
    }
});

function createVerificationCode() {
    return String(crypto.randomInt(100000, 1000000));
}

function hashVerificationCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}

async function sendVerificationCode(user) {
    const code = createVerificationCode();

    verificationCodes.set(user.id, {
        hash: hashVerificationCode(code),
        expiresAt: Date.now() + 10 * 60 * 1000,
        attempts: 0,
        sentAt: Date.now()
    });

    await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: user.email,
        subject: 'NexusX email verification code',
        text: `Your NexusX verification code is ${code}. It expires in 10 minutes.`
    });
}

function requireVerifiedUser(user, response) {
    if (!user.emailVerified) {
        sendError(response, 403, 'Please verify your email before continuing.');
        return false;
    }
    return true;
}
app.use(express.json());
app.use(express.static(projectRoot));

function sendError(response, status, message) {
	return response.status(status).json({ error: message });
}

function userState(user) {
	return {
		user: user ? {
			id: user.id,
			name: user.name,
			email: user.email,
			emailVerified: Boolean(user.emailVerified),
		}: null,

		balances: user 
		? { DEMO: user.demobalance, REAL: user.realBalance }
		: { DEMO: 10000, REAL: 0 } ,
		residency: user
		? { status: user.residencyStatus, data: user.residencyData }
		: null
	}
}

async function getCurrentUser(request) {
	const sessionId = request.headers.cookie?.match(/nexusx_session=([^;]+)/)?.[1];
	const userId = sessions.get(sessionId);
	return userId ? database.findUserById(userId) : null;
}

async function requireUser(request, response) {
	const user = await getCurrentUser(request);
	if (!user) sendError(response, 401, 'Please log in first.');
	return user;
}

function setSession(response, userId) {
	const sessionId = crypto.randomUUID();
	sessions.set(sessionId, userId);
	response.setHeader('Set-Cookie', `nexusx_session=${sessionId}; HttpOnly; Path=/; SameSite=Lax`);
}

async function handleDarajaCallback(request, response) {
	const callback = request.body?.Body?.stkCallback;
	if (callback) {
		await database.settleMpesaTransaction(callback.CheckoutRequestID, callback.ResultCode);
		console.log(`Daraja callback ${callback.CheckoutRequestID}: ${callback.ResultCode} ${callback.ResultDesc}`);
	}
	return response.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}

app.post('/api/daraja/callback', handleDarajaCallback);

app.get('/api/daraja/config', (request, response) => {
	response.json(daraja.getDarajaConfig());
});

app.all('/api', async (request, response) => {
	const action = String(request.query.action || '').toLowerCase();
	const payload = request.body || {};

	try {
		if (action === 'signup' && request.method === 'POST') {
			if (!payload.name || !payload.email || !payload.password) return sendError(response, 400, 'Name, email, and password are required.');
			const email = String(payload.email).trim().toLowerCase();
			if (await database.findUserByEmail(email)) return sendError(response, 409, 'An account with that email already exists.');
			const user = {
				id: crypto.randomUUID(),
				name: String(payload.name).trim(),
				email,
				passwordHash: await bcrypt.hash(String(payload.password), 12),
				demoBalance: 10000,
				realBalance: 0,
				residencyStatus: 'UNVERIFIED',
				residencyData: null
			};
			await database.createUser(user);
			setSession(response, user.id);
			return response.status(201).json(userState(user));
		}

		if (action === 'login' && request.method === 'POST') {
			const email = String(payload.email || '').trim().toLowerCase();
			const user = await database.findUserByEmail(email);
			if (!user || !(await bcrypt.compare(String(payload.password || ''), user.passwordHash))) return sendError(response, 401, 'Invalid email or password.');
			setSession(response, user.id);
			return response.json(userState(user));
		}

		if (action === 'logout' && request.method === 'POST') {
			const sessionId = request.headers.cookie?.match(/nexusx_session=([^;]+)/)?.[1];
			sessions.delete(sessionId);
			response.setHeader('Set-Cookie', 'nexusx_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
			return response.json({ ok: true });
		}

		if (action === 'state' && request.method === 'GET') return response.json(userState(await getCurrentUser(request)));

		if (action === 'daraja_status' && request.method === 'GET') return response.json(daraja.getDarajaConfig());

		if (action === 'mpesa_stk_push' && request.method === 'POST') {
			const user = await requireUser(request, response);
			if (!user) return;
			const amount = Number(payload.amount);
			if (!Number.isFinite(amount) || amount < 1 || !/^254\d{9}$/.test(String(payload.phone_number))) return sendError(response, 400, 'Use a valid amount and Kenyan phone number in 254XXXXXXXXX format.');
			const transactionId = crypto.randomUUID();
			const result = await daraja.initiateStkPush({ phoneNumber: String(payload.phone_number), amount, accountReference: user.email });
			await database.recordTransaction({ id: transactionId, userId: user.id, type: 'DEPOSIT', amount, accountType: 'REAL', method: 'MPESA', status: 'PENDING', externalReference: result.CheckoutRequestID });
			return response.status(202).json({ ok: true, transactionId, daraja: result });
		}

		const user = await requireUser(request, response);
		if (action === 'send_verification_otp' && request.method === 'POST') {
            const user = await requireUser(request, response);
            if (!user) return;

            if (user.emailVerified) {
                return response.json({ ok: true, alreadyVerified: true });
            }

            const previous = verificationCodes.get(user.id);
            if (previous && Date.now() - previous.sentAt < 60000) {
                return sendError(response, 429, 'Please wait before requesting another code.');
            }

            await sendVerificationCode(user);
            return response.json({ ok: true, expiresIn: 600 });
        }

        if (action === 'verify_email_otp' && request.method === 'POST') {
            const user = await requireUser(request, response);
            if (!user) return;

            const record = verificationCodes.get(user.id);
            const code = String(payload.code || '').trim();

            if (!record || !/^\d{6}$/.test(code)) {
                return sendError(response, 400, 'Invalid or expired verification code.');
            }

            if (Date.now() > record.expiresAt) {
                verificationCodes.delete(user.id);
                return sendError(response, 400, 'Verification code expired.');
            }

            record.attempts += 1;

            if (record.attempts > 5) {
                verificationCodes.delete(user.id);
                return sendError(response, 429, 'Too many attempts. Request a new code.');
            }

            if (hashVerificationCode(code) !== record.hash) {
                return sendError(response, 400, 'Invalid verification code.');
            }

            user.emailVerified = true;
            await database.updateUser(user);
            verificationCodes.delete(user.id);

            return response.json({ ok: true, ...userState(user) });
        }

  if (action === 'residency' && request.method === 'POST') {
if (action === 'send_verification_otp' && request.method === 'POST') {
    const user = await requireUser(request, response);
    if (!user) return;
if (action === 'send_verification_otp' && request.method === 'POST')
    if (user.emailVerified) {
        return response.json({ ok: true, alreadyVerified: true });
    }

    const previous = verificationCodes.get(user.id);
    if (previous && Date.now() - previous.sentAt < 60000) {
        return sendError(response, 429, 'Please wait before requesting another code.');
    }

    await sendVerificationCode(user);
    return response.json({ ok: true, expiresIn: 600 });
 }
}

	if (action === 'residency' && request.method === 'POST') {
			user.residencyStatus = 'PENDING';
			user.residencyData = { country: payload.country, full_name: payload.full_name, id_number: payload.id_number, address: payload.address };
			await database.updateUser(user);
		} else if ((action === 'deposit' || action === 'withdraw') && request.method === 'POST') {
			const amount = Number(payload.amount);
			const accountType = payload.account_type === 'REAL' ? 'REAL' : 'DEMO';
			const balanceKey = accountType === 'REAL' ? 'realBalance' : 'demoBalance';
			if (!Number.isFinite(amount) || amount <= 0) return sendError(response, 400, 'Amount must be greater than zero.');
			if (action === 'withdraw' && user[balanceKey] < amount) return sendError(response, 400, 'Insufficient balance.');
			user[balanceKey] += action === 'deposit' ? amount : -amount;
			await database.updateUser(user);
			await database.recordTransaction({ id: crypto.randomUUID(), userId: user.id, type: action.toUpperCase(), amount, accountType, method: payload.method, status: 'COMPLETED' });
		} else if (action === 'order' && request.method === 'POST') {
			const amount = Number(payload.amount || payload.lots || 0);
			if (!Number.isFinite(amount) || amount <= 0) return sendError(response, 400, 'Order amount must be greater than zero.');
		} else {
			return sendError(response, 404, 'Unknown API action.');
		}

		return response.json({ ok: true, ...userState(user) });
	} catch (error) {
		console.error(error);
		return sendError(response, error.message.includes('not configured') ? 503 : 500, error.message.includes('not configured') ? error.message : 'Internal server error.');
	}
});

database.initializeDatabase()
	.then(() => {
		app.listen(port, () => console.log(`NexusX server running at http://localhost:${port} (${database.usingPostgres ? 'PostgreSQL' : 'JSON fallback'})`));
	})
	.catch((error) => {
		console.error('Database initialization failed:', error);
		process.exitCode = 1;
	});

process.on('SIGTERM', () => database.closeDatabase());
process.on('SIGINT', () => database.closeDatabase());

