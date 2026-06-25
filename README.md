# OmniShift — Firebase Backend Setup

This package wires `index.html` to a real Firebase backend. You said your
Firebase project (`omnishift-2026`) already has Auth and Firestore enabled,
so this is the remaining setup.

## What changed in this revision

- **No more Admin/Viewer picker at login.** There's one login form (email +
  password). After Firebase Auth succeeds, the app reads `role` from the
  user's `profiles` document and routes them accordingly — role is never
  chosen by the user, only read from what's stored server-side.
- **No public sign-up.** The "Daftar" flow is gone. From now on, every
  account (after the first) is created by an Admin from the Users page.
- **First-admin bootstrap.** The very first account ever created becomes
  Admin automatically, via a hidden one-time setup page at:
  ```
  https://your-domain/index.html?setup=1
  ```
  This isn't linked anywhere in the normal UI. It calls a new Cloud
  Function, `bootstrapFirstAdmin`, which only succeeds the *first* time
  it's ever called — it checks (inside a Firestore transaction, so it's
  race-safe) that the `profiles` collection is still empty before granting
  admin. Every call after the first is rejected, regardless of who makes it.

## Files in this package

- `index.html` — the app.
- `cloud-functions/index.js` — `bootstrapFirstAdmin` (first-admin setup),
  `adminCreateUser`, `adminResetPassword`, plus four Firestore triggers
  that auto-write the audit log.
- `cloud-functions/package.json` — dependencies for the functions above.
- `firestore.rules` — the real authorization layer. **Deploy this before
  giving anyone but yourself access** — without it, any signed-in user can
  write anything, since the in-app `requireAdmin()` check is client-side
  only and trivially bypassed via devtools.
- `firestore.indexes.json` — composite index the audit log filter needs.

## 1. Enable Email/Password sign-in

Firebase Console → Authentication → Sign-in method → enable **Email/Password**.

## 2. Deploy Cloud Functions + Rules first

The bootstrap page depends on `bootstrapFirstAdmin` already being deployed,
and on `firestore.rules` already being live (the rules let *anyone signed
in* create their own `profiles` doc with `role: viewer` — bootstrap relies
on the Cloud Function bypassing rules via the Admin SDK to grant `admin`
instead). Deploy in this order:

```bash
npm install -g firebase-tools   # if you don't have it
firebase login
firebase init functions         # point it at the omnishift-2026 project, choose JavaScript
# replace the generated functions/index.js and functions/package.json
# with cloud-functions/index.js and cloud-functions/package.json from this package
cd functions && npm install && cd ..
firebase deploy --only functions
firebase deploy --only firestore:rules,firestore:indexes
```

Functions require the **Blaze (pay-as-you-go)** plan — Cloud Functions
aren't available on the free Spark plan. Cost at this app's scale
(a handful of admin actions per day) will be effectively $0/month.

## 3. Create your first Admin account

Upload `index.html` somewhere reachable, then visit:

```
https://wherever-you-host-it/index.html?setup=1
```

Fill in your name, email, and password, and submit. That's it — you're
now Admin. From there, create every other account through the Users page
(which calls `adminCreateUser`) — no more manual Console work needed, and
the `?setup=1` page will refuse every future attempt automatically.

> If you'd rather not expose `?setup=1` at all (even temporarily), you can
> instead bootstrap manually via the Firebase Console: Authentication →
> Add user, then Firestore → create a `profiles/{that user's UID}` document
> with `role: "admin"`, `is_active: true`. Either path works; the Console
> route never touches `bootstrapFirstAdmin` at all.

## What the rules actually enforce

- Anyone signed in and "active" (per their `profiles` doc) can **read**
  employees/schedules/settings — Viewers need this to see the calendar.
- Only `role: admin` + `is_active: true` can **write** to
  employees/schedules/settings, or edit another user's profile.
- A user can always update their *own* `color` field without being admin.
- A signed-in user with no existing profile can create their **own**
  `profiles` doc, but only with `role: viewer, is_active: true` — they
  cannot grant themselves admin this way. (This rule exists for symmetry
  with the old self-signup flow; in practice nothing in the current UI
  exercises it, since accounts are created by `adminCreateUser` or
  `bootstrapFirstAdmin`, both of which use the Admin SDK and bypass rules.)
- `audit_log` is admin-read-only, and **never** client-writable — entries
  are written exclusively by the Cloud Functions, using the Admin SDK,
  which bypasses these rules. This is intentional: a write path that's
  only reachable server-side can't be forged by a modified client.

## Known limitation worth knowing about

The audit triggers attribute changes to whoever's UID is in a write's
`updated_by` field. The client now stamps that field on every
employees/profiles/settings/schedules write. For **deletes** (e.g. Factory
Reset, Reset Month), there's no new payload to stamp, so the trigger falls
back to whoever last *wrote* that document — not necessarily whoever
issued the delete. If exact delete-attribution matters to you, that would
need each delete routed through a small Cloud Function instead of a direct
client-side `deleteDoc`, which I did not build out here.

