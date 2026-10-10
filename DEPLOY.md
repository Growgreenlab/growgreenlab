# Deploying Trade Replay Lab v2 (free tiers)

Everything below is free. You do not need to buy anything except, later,
an optional custom domain.

## 1. Create a free Supabase project

1. Go to https://supabase.com and sign up (GitHub login is easiest).
2. Click **New project**, name it `trade-replay-lab`, pick a region near you,
   set a database password (save it somewhere safe), and create it.
3. Wait a minute while it provisions.

## 2. Create the database tables

1. In the Supabase dashboard, open **SQL Editor** (left sidebar).
2. Click **New query**, paste the entire contents of `supabase/schema.sql`
   from this repo, and press **Run**.
3. You should see "Success. No rows returned". This creates the
   `profiles`, `replay_sessions`, and `session_trades` tables, plus the
   security rules (Row Level Security) so users only ever see their own data.

## 3. Copy your API keys

1. In Supabase, go to **Settings → API**.
2. Copy the **Project URL** and the **anon public** key.
3. Keep the **service_role** key secret — you do not need it for this app.

## 4. Push this repo to GitHub

1. Create a free GitHub account if you do not have one.
2. Create a new repository (e.g. `trade-replay-lab-v2`), then from this
   folder run:
   ```bash
   git init
   git add .
   git commit -m "Trade Replay Lab v2"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/trade-replay-lab-v2.git
   git push -u origin main
   ```

## 5. Import into Vercel

1. Go to https://vercel.com and sign up (use GitHub login).
2. Click **Add New → Project**, then **Import** your
   `trade-replay-lab-v2` repository.
3. Keep the defaults (Framework Preset: Next.js) and continue.

## 6. Set the environment variables

Before deploying, open the **Environment Variables** section and add:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | the Project URL from step 3 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon public key from step 3 |

## 7. Deploy

Click **Deploy**. After a minute or two you get a live URL like
`trade-replay-lab-v2.vercel.app`. Sign in with your email (magic link),
open the Replay Lab, and you are trading history.

Every `git push` to `main` redeploys automatically.

## Adding a custom domain later (optional)

1. Buy the domain from any registrar (e.g. Cloudflare, Namecheap,
   Porkbun — roughly $10–15/year).
2. In Vercel, open your project → **Settings → Domains** → **Add**,
   and type your domain.
3. Vercel shows you the DNS records to add (an `A` record or CNAME).
   Add those at your registrar where the domain lives.
4. Wait a few minutes for DNS to propagate — Vercel provisions HTTPS
   automatically. No server config needed on your side.

## Notes

- **Twelve Data key**: each user pastes their *own* free key inside the app
  (Data source → Twelve Data). It stays in their browser and is never sent
  to your server. Get one free at twelvedata.com.
- **Email login**: Supabase sends magic-link emails from its own service on
  the free tier (rate-limited but fine to start). For higher volume later,
  plug in your own SMTP under Supabase → Authentication → Emails.
- **Free-tier limits** (generous to start): Supabase free includes a 500 MB
  database; Vercel free includes 100 GB bandwidth/month. A saved session is
  only tens of kilobytes.
