const crypto = require('crypto');

const isProduction = process.env.MPESA_ENV === 'production';
const baseUrl = isProduction ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

function getDarajaConfig() {
	return {
		configured: Boolean(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET && process.env.MPESA_SHORTCODE && process.env.MPESA_PASSKEY),
		environment: isProduction ? 'production' : 'sandbox',
		shortcode: process.env.MPESA_SHORTCODE || null,
		callbackUrl: process.env.MPESA_CALLBACK_URL || null
	};
}

function requireConfig() {
	if (!getDarajaConfig().configured) throw new Error('Daraja is not configured. Add the MPESA_* variables to .env.');
}

async function getAccessToken() {
	requireConfig();
	const credentials = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
	const response = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
		headers: { Authorization: `Basic ${credentials}` }
	});
	const result = await response.json();
	if (!response.ok || !result.access_token) throw new Error(result.errorMessage || 'Unable to authenticate with Daraja.');
	return result.access_token;
}

async function initiateStkPush({ phoneNumber, amount, accountReference, transactionDesc }) {
	requireConfig();
	if (!process.env.MPESA_CALLBACK_URL) throw new Error('MPESA_CALLBACK_URL is required for STK Push.');
	const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
	const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
	const accessToken = await getAccessToken();
	const response = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			BusinessShortCode: process.env.MPESA_SHORTCODE,
			Password: password,
			Timestamp: timestamp,
			TransactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
			Amount: Math.round(Number(amount)),
			PartyA: phoneNumber,
			PartyB: process.env.MPESA_SHORTCODE,
			PhoneNumber: phoneNumber,
			CallBackURL: process.env.MPESA_CALLBACK_URL,
			AccountReference: accountReference || process.env.MPESA_ACCOUNT_REFERENCE || 'NexusX',
			TransactionDesc: transactionDesc || process.env.MPESA_TRANSACTION_DESC || 'NexusX account deposit'
		})
	});
	const result = await response.json();
	if (!response.ok || result.ResponseCode && result.ResponseCode !== '0') throw new Error(result.errorMessage || result.ResponseDescription || 'Daraja STK Push failed.');
	return result;
}

function createCallbackReference() {
	return crypto.randomUUID();
}

module.exports = { createCallbackReference, getDarajaConfig, initiateStkPush };
