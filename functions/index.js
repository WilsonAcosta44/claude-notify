const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions, params } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const crypto = require("crypto");

admin.initializeApp();
setGlobalOptions({ region: "us-central1" });

const db = getFirestore();

// Shared secret — set via: firebase functions:secrets:set NOTIFY_SECRET
// Hook sends it as: Authorization: Bearer <secret>
const NOTIFY_SECRET = process.env.NOTIFY_SECRET || "";

function tokenDocId(fcmToken) {
  return crypto.createHash("sha256").update(fcmToken).digest("hex");
}

function checkSecret(req, res) {
  if (!NOTIFY_SECRET) return true; // secret not configured — allow (warn in logs)
  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (provided !== NOTIFY_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * POST /notify
 * Called by the Claude Code Stop hook. Requires Authorization: Bearer <NOTIFY_SECRET>.
 */
exports.notify = onRequest({ cors: ["https://claude-notify.web.app"], secrets: ["NOTIFY_SECRET"] }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  if (!checkSecret(req, res)) return;

  const { title = "Claude is waiting", body = "Your session needs input" } =
    req.body || {};

  try {
    const snap = await db.collection("push_tokens").get();
    if (snap.empty) {
      res.status(200).json({ sent: 0, message: "No registered tokens" });
      return;
    }

    const docs = snap.docs.filter((d) => d.data().token);
    if (!docs.length) {
      res.status(200).json({ sent: 0, message: "No valid tokens" });
      return;
    }

    const messaging = getMessaging();
    const sendResults = await Promise.allSettled(
      docs.map((d) =>
        messaging.send({
          token: d.data().token,
          notification: { title, body },
          webpush: {
            notification: {
              title,
              body,
              icon: "/icon-192.png",
              badge: "/badge-72.png",
              requireInteraction: false,
              silent: false,
            },
            fcmOptions: { link: "/" },
          },
        })
      )
    );

    // Delete stale docs directly from the snapshot — no second Firestore round-trip,
    // and no Firestore `in` query (which is capped at 30 items).
    const staleDocs = docs.filter(
      (_, i) =>
        sendResults[i].status === "rejected" &&
        sendResults[i].reason?.errorInfo?.code ===
          "messaging/registration-token-not-registered"
    );

    if (staleDocs.length) {
      const batch = db.batch();
      staleDocs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }

    const sent = sendResults.filter((r) => r.status === "fulfilled").length;
    res.status(200).json({ sent, total: docs.length });
  } catch (err) {
    console.error("notify error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /register
 * Called by the PWA after obtaining an FCM push token.
 */
exports.register = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const { token } = req.body || {};
  if (!token || typeof token !== "string" || token.length > 4096) {
    res.status(400).json({ error: "valid token required" });
    return;
  }

  try {
    // Use SHA-256 of the full token as the doc ID — avoids truncation collisions.
    await db.collection("push_tokens").doc(tokenDocId(token)).set(
      {
        token,
        registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ error: err.message });
  }
});
