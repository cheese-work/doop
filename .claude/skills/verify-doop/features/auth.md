# auth

## Sub-features

- Email sign-up (`POST /api/auth/sign-up/email`), session cookie, `GET /api/me`.
- Sign-in and password reset screens: `src/pages/AuthPage.tsx` (not driven yet).

## How to get to it (user POV)

Open `/` signed out. The auth screen asks for Name, Email and Password (8+ characters).

## Driving it with `drive.mjs auth`

1. Sign up through the auth API inside the page, so the browser holds the session cookie.
2. `fetch('/api/me')`: the account email matches.
3. Load `/` again: the signed-in home renders (screenshot `auth-signed-in-home.png`).

## Gotchas

- The launch sets `REQUIRE_EMAIL_VERIFICATION=false`. With it on, sign-up needs a mail round trip.
- The email uses a timestamp suffix; reuse one launch for several drives without clashes.
