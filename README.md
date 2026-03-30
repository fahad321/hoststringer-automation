# Hoststringer Campaign Sender

A local web app that lets you:
- upload an Excel leads file (`.xlsx`)
- log in with Hostinger SMTP credentials
- write subject/body templates with placeholders like `{{name}}` and `{{email}}`
- send emails one-by-one automatically

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## How To Use

1. Fill Hostinger SMTP login details.
2. Upload your Excel file.
3. Click **Preview Excel** to inspect parsed data.
4. Write email templates using placeholders from your Excel column names.
5. Click **Send Campaign**.

## Placeholder Notes

- Excel headers are normalized to lowercase with underscores.
- Example:
  - `Full Name` becomes `{{full_name}}`
  - `Email Address` becomes `{{email_address}}`
- Special mapped placeholders:
  - `{{name}}`
  - `{{email}}`

## Test

```bash
npm test
```
