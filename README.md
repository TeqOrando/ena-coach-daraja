# ENA Coach — real M-Pesa STK Push

This package serves the booking HTML and the Daraja backend from the same Express server, so you should NOT open the HTML with `file://`. Open the website through the backend URL.

## What is fixed
- Customer sees only the M-Pesa phone field; Paybill/account are not displayed.
- STK destination is Paybill `247247`, account `0320185161128`.
- Uses `CustomerPayBillOnline`.
- Uses a public HTTPS callback URL.
- Returns the actual Daraja error instead of the generic "Unable to send..." message.
- Uses Kenya UTC+3 timestamp generation.
- Does not mark a booking paid until Safaricom's callback reports success.

## Required Daraja setup
Create an app in the official Safaricom Daraja portal and obtain the Consumer Key, Consumer Secret and STK Push Passkey. Daraja is Safaricom's official API platform for M-PESA integrations.

Create `.env` from `.env.example` and fill in the credentials. Keep the Consumer Secret and Passkey server-side only.

For production:
DARAJA_BASE_URL=https://api.safaricom.co.ke
PUBLIC_BASE_URL=https://your-public-domain.example.com

The callback will be:
https://your-public-domain.example.com/api/mpesa/callback

## Run
npm install
npm start

Then open:
http://localhost:3000

For a real phone prompt, the deployed server must be publicly reachable over HTTPS and the Daraja app must be configured for the same environment (sandbox or production).

## Troubleshooting
Visit `/health`. It reports whether the required environment variables are present without exposing their values.

If STK still fails, check the server console. The fixed backend logs the HTTP status and Daraja response so the exact rejection can be identified.

Official portal: https://developer.safaricom.co.ke/
