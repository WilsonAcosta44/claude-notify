import React, { useState, useEffect, useCallback } from "react";
import {
  messaging,
  requestPushToken,
  registerTokenWithServer,
  onMessage,
} from "./firebase";

const STATUS = {
  IDLE: "idle",
  REQUESTING: "requesting",
  REGISTERED: "registered",
  ERROR: "error",
  UNSUPPORTED: "unsupported",
};

function Toast({ toasts }) {
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span className="toast-icon">🤖</span>
          <div>
            <div className="toast-title">{t.title}</div>
            <div className="toast-body">{t.body}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState(STATUS.IDLE);
  const [error, setError] = useState("");
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((title, body) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, title, body }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  useEffect(() => {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setStatus(STATUS.UNSUPPORTED);
    }
  }, []);

  // Listen for foreground FCM messages (app is open)
  useEffect(() => {
    const unsub = onMessage(messaging, (payload) => {
      const title = payload.notification?.title || "Claude is waiting";
      const body =
        payload.notification?.body || "Your session needs your input";
      addToast(title, body);
      // Also show a native notification if we can
      if (Notification.permission === "granted") {
        new Notification(title, {
          body,
          icon: "/icon-192.png",
          tag: "claude-notify",
        });
      }
    });
    return unsub;
  }, [addToast]);

  async function handleEnable() {
    setStatus(STATUS.REQUESTING);
    setError("");
    try {
      const token = await requestPushToken();
      if (!token) {
        setError("Notification permission denied. Please allow notifications and try again.");
        setStatus(STATUS.ERROR);
        return;
      }
      await registerTokenWithServer(token);
      setStatus(STATUS.REGISTERED);
      // Store token locally so we know we're registered
      localStorage.setItem("claude_notify_token", token);
    } catch (err) {
      setError(err.message || "Something went wrong.");
      setStatus(STATUS.ERROR);
    }
  }

  // Re-check if we were previously registered
  useEffect(() => {
    const saved = localStorage.getItem("claude_notify_token");
    if (saved && Notification.permission === "granted") {
      setStatus(STATUS.REGISTERED);
    }
  }, []);

  return (
    <div className="app">
      <Toast toasts={toasts} />

      <div className="card">
        <div className="logo">🤖</div>
        <h1>Claude Notify</h1>
        <p className="subtitle">
          Get a push notification on this device whenever Claude Code finishes a
          response and is waiting for your input.
        </p>

        {status === STATUS.UNSUPPORTED && (
          <div className="alert alert-error">
            Push notifications are not supported in this browser. Try Chrome or
            Edge on Android, or Safari 16.4+ on iOS.
          </div>
        )}

        {status === STATUS.IDLE && (
          <button className="btn btn-primary" onClick={handleEnable}>
            Enable Notifications
          </button>
        )}

        {status === STATUS.REQUESTING && (
          <button className="btn btn-primary" disabled>
            <span className="spinner" /> Connecting…
          </button>
        )}

        {status === STATUS.REGISTERED && (
          <>
            <div className="alert alert-success">
              ✅ This device is registered. You'll receive a notification
              whenever Claude Code awaits your input.
            </div>
            <button
              className="btn btn-ghost"
              onClick={() => {
                addToast("Claude is waiting", "Test notification — it works!");
              }}
            >
              Send test notification
            </button>
          </>
        )}

        {status === STATUS.ERROR && (
          <>
            <div className="alert alert-error">{error}</div>
            <button className="btn btn-primary" onClick={handleEnable}>
              Try Again
            </button>
          </>
        )}
      </div>

      <footer>
        <p>
          Add this page to your home screen for the best experience. Notifications
          are delivered via Firebase Cloud Messaging.
        </p>
      </footer>
    </div>
  );
}
