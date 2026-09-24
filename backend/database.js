const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = path.join(projectRoot, 'data');
const dataFile = path.join(dataDirectory, 'nexusx.json');
const usePostgres = Boolean(process.env.DATABASE_URL);
const pool = usePostgres
	? new Pool({
		connectionString: process.env.DATABASE_URL,
		ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
	})
	: null;

function loadFileDatabase() {
	try {
		return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
	} catch (error) {
		return { users: [], transactions: [] };
	}
}

function saveFileDatabase(database) {
	fs.mkdirSync(dataDirectory, { recursive: true });
	fs.writeFileSync(dataFile, JSON.stringify(database, null, 2));
}

async function initializeDatabase() {
	if (!usePostgres) return;
	await pool.query(`
		CREATE TABLE IF NOT EXISTS users (
			id UUID PRIMARY KEY,
			name TEXT NOT NULL,
			email TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			demo_balance NUMERIC(18, 2) NOT NULL DEFAULT 10000,
			real_balance NUMERIC(18, 2) NOT NULL DEFAULT 0,
			residency_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
			residency_data JSONB,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
		CREATE TABLE IF NOT EXISTS transactions (
			id UUID PRIMARY KEY,
			user_id UUID NOT NULL REFERENCES users(id),
			type TEXT NOT NULL,
			amount NUMERIC(18, 2) NOT NULL,
			account_type TEXT NOT NULL,
			method TEXT,
			status TEXT NOT NULL DEFAULT 'COMPLETED',
			external_reference TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);
}

function mapUser(row) {
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		passwordHash: row.password_hash,
		demoBalance: Number(row.demo_balance),
		realBalance: Number(row.real_balance),
		residencyStatus: row.residency_status,
		residencyData: row.residency_data || null
	};
}

async function findUserByEmail(email) {
	if (!usePostgres) return loadFileDatabase().users.find((user) => user.email === email) || null;
	const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
	return mapUser(result.rows[0]);
}

async function findUserById(id) {
	if (!usePostgres) return loadFileDatabase().users.find((user) => user.id === id) || null;
	const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
	return mapUser(result.rows[0]);
}

async function createUser(user) {
	if (!usePostgres) {
		const database = loadFileDatabase();
		database.users.push(user);
		saveFileDatabase(database);
		return user;
	}
	await pool.query(
		`INSERT INTO users (id, name, email, password_hash, demo_balance, real_balance, residency_status, residency_data)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		[user.id, user.name, user.email, user.passwordHash, user.demoBalance, user.realBalance, user.residencyStatus, user.residencyData]
	);
	return user;
}

async function updateUser(user) {
	if (!usePostgres) {
		const database = loadFileDatabase();
		const index = database.users.findIndex((candidate) => candidate.id === user.id);
		if (index >= 0) database.users[index] = user;
		saveFileDatabase(database);
		return user;
	}
	await pool.query(
		`UPDATE users SET demo_balance = $2, real_balance = $3, residency_status = $4, residency_data = $5 WHERE id = $1`,
		[user.id, user.demoBalance, user.realBalance, user.residencyStatus, user.residencyData]
	);
	return user;
}

async function recordTransaction(transaction) {
	if (!usePostgres) {
		const database = loadFileDatabase();
		database.transactions = database.transactions || [];
		database.transactions.push(transaction);
		saveFileDatabase(database);
		return;
	}
	await pool.query(
		`INSERT INTO transactions (id, user_id, type, amount, account_type, method, status, external_reference)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		[transaction.id, transaction.userId, transaction.type, transaction.amount, transaction.accountType, transaction.method || null, transaction.status, transaction.externalReference || null]
	);
}

async function settleMpesaTransaction(externalReference, resultCode) {
	const status = Number(resultCode) === 0 ? 'COMPLETED' : 'FAILED';
	if (!usePostgres) {
		const database = loadFileDatabase();
		const transaction = (database.transactions || []).find((candidate) => candidate.externalReference === externalReference);
		if (!transaction || transaction.status !== 'PENDING') return transaction || null;
		transaction.status = status;
		if (status === 'COMPLETED') {
			const user = database.users.find((candidate) => candidate.id === transaction.userId);
			if (user) user.realBalance += Number(transaction.amount);
		}
		saveFileDatabase(database);
		return transaction;
	}

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const result = await client.query('SELECT * FROM transactions WHERE external_reference = $1 FOR UPDATE', [externalReference]);
		const transaction = result.rows[0];
		if (!transaction || transaction.status !== 'PENDING') {
			await client.query('COMMIT');
			return transaction || null;
		}
		await client.query('UPDATE transactions SET status = $2 WHERE id = $1', [transaction.id, status]);
		if (status === 'COMPLETED') await client.query('UPDATE users SET real_balance = real_balance + $2 WHERE id = $1', [transaction.user_id, transaction.amount]);
		await client.query('COMMIT');
		return transaction;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

async function closeDatabase() {
	if (pool) await pool.end();
}

module.exports = {
	closeDatabase,
	createUser,
	findUserByEmail,
	findUserById,
	initializeDatabase,
	recordTransaction,
	settleMpesaTransaction,
	updateUser,
	usingPostgres: usePostgres
};
