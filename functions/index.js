const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

admin.initializeApp();
setGlobalOptions({ region: "us-central1" });

const db = getFirestore();

/**
 * POST /notify
 * Called by the Claude Code Stop hook on the user's machine.
 * Reads all registered FCM tokens from Firestore and sends a push to each.
 */
exports.notify = onRequest({ cors: true }, async (req, res) => {
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const { title = "Claude is waiting", body = "Your session needs input" } =
    req.body || {};

  try {
    // Load all registered push tokens
    const snap = await db.collection("push_tokens").get();
    if (snap.empty) {
      res.status(200).json({ sent: 0, message: "No registered tokens" });
      return;
    }

    const tokens = snap.docs.map((d) => d.data().token).filter(Boolean);
    if (!tokens.length) {
      res.status(200).json({ sent: 0, message: "No valid tokens" });
      return;
    }

    const messaging = getMessaging();
    const sendResults = await Promise.allSettled(
      tokens.map((token) =>
        messaging.send({
          token,
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

    // Remove any tokens that FCM reports as invalid/expired
    const staleTokens = [];
    sendResults.forEach((result, i) => {
      if (
        result.status === "rejected" &&
        result.reason?.errorInfo?.code ===
          "messaging/registration-token-not-registered"
      ) {
        staleTokens.push(tokens[i]);
      }
    });

    if (staleTokens.length) {
      const batch = db.batch();
      const staleSnap = await db
        .collection("push_tokens")
        .where("token", "in", staleTokens)
        .get();
      staleSnap.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }

    const sent = sendResults.filter((r) => r.status === "fulfilled").length;
    res.status(200).json({ sent, total: tokens.length });
  } catch (err) {
    console.error("notify error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /register
 * Called by the PWA after obtaining an FCM push token.
 * Stores the token in Firestore.
 */
exports.register = onRequest({ cors: true }, async (req, res) => {
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const { token } = req.body || {};
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "token required" });
    return;
  }

  try {
    // Upsert by token value so we don't accumulate duplicates
    await db.collection("push_tokens").doc(token.slice(0, 100)).set(
      {
        token,
        registeredAt: admin.firestore.FieldValue.serverTimestamp(),
        userAgent: req.headers["user-agent"] || "",
      },
      { merge: true }
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ error: err.message });
  }
});
