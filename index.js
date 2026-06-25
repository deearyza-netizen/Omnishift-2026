/**
 * OmniShift — Cloud Functions
 * ===========================
 * Privileged backend operations that cannot run safely in client-side JS,
 * plus Firestore triggers that maintain the `audit_log` collection
 * automatically whenever `employees`, `schedules`, `profiles`, or `settings`
 * documents are written.
 *
 * DEPLOY:
 *   1. firebase init functions   (choose JavaScript, this project)
 *   2. Copy this file to functions/index.js
 *   3. cd functions && npm install firebase-admin firebase-functions
 *   4. firebase deploy --only functions
 *
 * Callable functions, invoked from the client:
 *   httpsCallable(functions, 'bootstrapFirstAdmin')({ name })
 *     — only succeeds the very first time it's ever called (transactionally
 *       checks the `profiles` collection is empty). See doBootstrapFirstAdmin()
 *       in index.html, reachable via the hidden ?setup=1 page.
 *   httpsCallable(functions, 'adminCreateUser')({ username, name, role, password })
 *   httpsCallable(functions, 'adminResetPassword')({ userId, newPassword })
 *     — both require the caller to already be an active admin.
 * (see callAdminApi() and doBootstrapFirstAdmin() in index.html)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────────────────
//  Shared helper: verifies the caller is authenticated AND is an
//  active admin according to their `profiles` document. Never trust
//  client-supplied role claims — always re-check server-side.
// ─────────────────────────────────────────────────────────
async function requireCallerIsActiveAdmin(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Anda harus login untuk melakukan ini.');
  }
  const callerSnap = await db.collection('profiles').doc(request.auth.uid).get();
  const caller = callerSnap.data();
  if (!callerSnap.exists || caller.role !== 'admin' || caller.is_active === false) {
    throw new HttpsError('permission-denied', 'Hanya Admin aktif yang dapat melakukan ini.');
  }
  return caller;
}

// ─────────────────────────────────────────────────────────
//  bootstrapFirstAdmin — the ONLY way to create an account without
//  already being an admin. Callable by anyone signed in (the client
//  creates the Firebase Auth account itself via createUserWithEmailAndPassword,
//  then calls this), but it only succeeds once: the very first time it's
//  called while the `profiles` collection is empty. Every call after that
//  is rejected, regardless of who calls it.
//
//  This is intentionally NOT reachable from the normal login screen —
//  index.html only calls this from a hidden one-time setup page
//  (?setup=1), so a stray public sign-up form can't trigger it.
// ─────────────────────────────────────────────────────────
exports.bootstrapFirstAdmin = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Anda harus login untuk melakukan ini.');
  }
  const { name } = request.data || {};
  const uid = request.auth.uid;

  try {
    await db.runTransaction(async (tx) => {
      // Firestore transactions don't support arbitrary collection-count
      // reads, so we cap the check at 1 document — if even one profile
      // exists, this transaction aborts and the setup endpoint is closed
      // for good.
      const existingSnap = await tx.get(db.collection('profiles').limit(1));
      if (!existingSnap.empty) {
        throw new HttpsError('already-exists', 'Admin pertama sudah ada. Hubungi Admin untuk dibuatkan akun.');
      }
      tx.set(db.collection('profiles').doc(uid), {
        username: request.auth.token.email || '',
        name: name || request.auth.token.email || 'Admin',
        role: 'admin',
        is_active: true,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_by: uid,
      });
    });
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', err.message || 'Gagal membuat admin pertama.');
  }

  await writeAuditLog({
    action: 'INSERT',
    table_name: 'profiles',
    record_id: uid,
    old_data: {},
    new_data: { role: 'admin', bootstrap: true },
    actor_id: uid,
    actor_name: name || request.auth.token.email,
    actor_username: request.auth.token.email,
  });

  return { success: true };
});

// ─────────────────────────────────────────────────────────
//  adminCreateUser — creates a new Firebase Auth account + profile doc.
//  body: { username (email), name, role: 'admin'|'viewer', password }
// ─────────────────────────────────────────────────────────
exports.adminCreateUser = onCall(async (request) => {
  const caller = await requireCallerIsActiveAdmin(request);
  const { username, name, role, password } = request.data || {};

  if (!username || !password) {
    throw new HttpsError('invalid-argument', 'Username dan password wajib diisi.');
  }
  if (password.length < 6) {
    throw new HttpsError('invalid-argument', 'Password minimal 6 karakter.');
  }
  if (!/^[a-z0-9._-]+@?/.test(username)) {
    // username field in this app is actually an email address
  }
  const finalRole = role === 'admin' ? 'admin' : 'viewer';

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: username,
      password: password,
      displayName: name || username,
    });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'Username sudah digunakan.');
    }
    if (err.code === 'auth/invalid-email') {
      throw new HttpsError('invalid-argument', 'Format username/email tidak valid.');
    }
    throw new HttpsError('internal', err.message || 'Gagal membuat akun.');
  }

  await db.collection('profiles').doc(userRecord.uid).set({
    username,
    name: name || username,
    role: finalRole,
    is_active: true,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeAuditLog({
    action: 'INSERT',
    table_name: 'profiles',
    record_id: userRecord.uid,
    old_data: {},
    new_data: { username, name: name || username, role: finalRole },
    actor_id: caller && request.auth.uid,
    actor_name: caller.name,
    actor_username: caller.username,
  });

  return { uid: userRecord.uid };
});

// ─────────────────────────────────────────────────────────
//  adminResetPassword — sets a new password for another user's account.
//  body: { userId, newPassword }
// ─────────────────────────────────────────────────────────
exports.adminResetPassword = onCall(async (request) => {
  const caller = await requireCallerIsActiveAdmin(request);
  const { userId, newPassword } = request.data || {};

  if (!userId || !newPassword) {
    throw new HttpsError('invalid-argument', 'User dan password baru wajib diisi.');
  }
  if (newPassword.length < 6) {
    throw new HttpsError('invalid-argument', 'Password minimal 6 karakter.');
  }

  try {
    await admin.auth().updateUser(userId, { password: newPassword });
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'User tidak ditemukan.');
    }
    throw new HttpsError('internal', err.message || 'Gagal mengganti password.');
  }

  const targetSnap = await db.collection('profiles').doc(userId).get();
  await writeAuditLog({
    action: 'UPDATE',
    table_name: 'profiles',
    record_id: userId,
    old_data: {},
    new_data: { password_reset: true, target_username: targetSnap.data()?.username || '' },
    actor_id: request.auth.uid,
    actor_name: caller.name,
    actor_username: caller.username,
  });

  return { success: true };
});

// ─────────────────────────────────────────────────────────
//  Audit log helper — used directly by the callables above (where we
//  already know who the actor is from the verified auth context).
// ─────────────────────────────────────────────────────────
async function writeAuditLog(entry) {
  await db.collection('audit_log').add({
    ...entry,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ─────────────────────────────────────────────────────────
//  Firestore triggers — automatically log every write to the four
//  tracked collections. This is the ONLY reliable place to write audit
//  log entries, since any client-side logging call could be skipped or
//  forged by a modified client. These triggers run with the Admin SDK's
//  full privileges and cannot be bypassed by client code.
// ─────────────────────────────────────────────────────────
function buildTrigger(tableName) {
  return onDocumentWritten(`${tableName}/{docId}`, async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;

    let action;
    if (!before && after) action = 'INSERT';
    else if (before && !after) action = 'DELETE';
    else action = 'UPDATE';

    // Skip no-op updates (e.g. a merge write that changed nothing).
    if (action === 'UPDATE' && JSON.stringify(before) === JSON.stringify(after)) return;

    // Resolve actor info. Writes from the admin Cloud Functions above
    // already carry their own audit entries, so to avoid double-logging
    // we only attribute actor identity here when we can determine it from
    // an `updated_by` field on the document itself (schedules) — otherwise
    // mark the entry as system-attributed.
    const docData = after || before;
    let actor_name = null, actor_username = null;
    const actorId = docData && docData.updated_by;
    if (actorId) {
      const actorSnap = await db.collection('profiles').doc(actorId).get();
      if (actorSnap.exists) {
        actor_name = actorSnap.data().name;
        actor_username = actorSnap.data().username;
      }
    }

    await db.collection('audit_log').add({
      action,
      table_name: tableName,
      record_id: event.params.docId,
      old_data: before || {},
      new_data: after || {},
      actor_name,
      actor_username,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
}

exports.auditEmployees = buildTrigger('employees');
exports.auditSchedules = buildTrigger('schedules');
exports.auditProfiles  = buildTrigger('profiles');
exports.auditSettings  = buildTrigger('settings');
