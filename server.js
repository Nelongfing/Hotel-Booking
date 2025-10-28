import express from "express";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import twilio from "twilio";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// PORT
const PORT = process.env.PORT || 8080;

// Twilio client
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

// Static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// Database setup
let db;
(async () => {
  db = await open({ filename: "./booking.db", driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      hotel_name TEXT,
      checkin TEXT,
      checkout TEXT,
      guests INTEGER,
      total_amount REAL,
      status TEXT
    )
  `);
})();

// Fetch hotels
app.get("/hotels", (req, res) => {
  const apiKey = process.env.LITEAPI_API_KEY;
  const page = parseInt(req.query.page || "1");
  const limit = parseInt(req.query.limit || "10");

  const url = "https://api.liteapi.travel/v3.0/data/hotels?countryCode=PH&cityName=Manila";
  const options = { headers: { "X-API-Key": apiKey } };

  https.get(url, options, (apiRes) => {
    let data = "";
    apiRes.on("data", (chunk) => (data += chunk));
    apiRes.on("end", () => {
      try {
        const json = JSON.parse(data);
        const hotels = (json.data || []).map((h) => ({
          id: h.id,
          name: h.name,
          description: h.hotelDescription?.replace(/<[^>]+>/g, ""),
          address: h.address,
          city: h.city,
          stars: h.stars,
          rating: h.rating,
          image: h.main_photo || h.thumbnail,
        }));
        const start = (page - 1) * limit;
        const end = start + limit;
        res.json({ data: hotels.slice(start, end), total: hotels.length });
      } catch (err) {
        console.error("Parse error:", err);
        res.status(500).json({ error: "Failed to parse hotels" });
      }
    });
  });
});

// Create booking + PayPal order
app.post("/bookings", async (req, res) => {
  try {
    console.log("📦 Incoming booking:", req.body);

    let { hotelName, total, checkin, checkout, guests, email } = req.body;
    if (!hotelName || !total) return res.status(400).json({ error: "Missing required fields" });
    total = Number(total);

    const result = await db.run(
      `INSERT INTO bookings (user_id, hotel_name, checkin, checkout, guests, total_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [1, hotelName, checkin || "N/A", checkout || "N/A", guests || 1, total, "pending"]
    );

    const bookingId = result.lastID;
    console.log("🔍 ENV CHECK:", {
      PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID ? "✅ found" : "❌ missing",
      PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET ? "✅ found" : "❌ missing",
    });

    // Get PayPal access token
    const authRes = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    const authData = await authRes.json();
    console.log("🔑 PayPal Auth Response:", authData);
    if (!authData.access_token) throw new Error("Missing PayPal access token");

    const accessToken = authData.access_token;
    const RAILWAY_URL = `https://${process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_URL}`;

    // Create PayPal order
    const orderRes = await fetch("https://api-m.sandbox.paypal.com/v2/checkout/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: total.toFixed(2) }, description: hotelName }],
        application_context: {
          return_url: `${RAILWAY_URL}/success.html?bookingId=${bookingId}&email=${encodeURIComponent(
            email || "user@example.com"
          )}`,
          cancel_url: `${RAILWAY_URL}/cancel.html`,
        },
      }),
    });

    const orderData = await orderRes.json();
    console.log("🧾 PayPal order:", orderData);

    const approveLink = orderData.links?.find((l) => l.rel === "approve")?.href;
    if (!approveLink) throw new Error("Missing PayPal approve link");

    res.json({ bookingId, approveUrl: approveLink });
  } catch (err) {
    console.error("❌ Create booking error:", err);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

// PayPal webhook
app.post("/payments/webhook/paypal", async (req, res) => {
  const { bookingId } = req.body;
  if (!bookingId) return res.status(400).json({ error: "Missing bookingId" });

  try {
    await db.run(`UPDATE bookings SET status = ? WHERE id = ?`, ["confirmed", bookingId]);
    res.send("ok");
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to confirm booking" });
  }
});

// Send SMS notification using Twilio
app.post("/notify-sms/:bookingId", async (req, res) => {
  const { phone } = req.body;
  const { bookingId } = req.params;

  if (!phone) return res.status(400).json({ error: "Missing phone number" });

  try {
    const booking = await db.get(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const message = `
Booking confirmed!
Hotel: ${booking.hotel_name}
Check-in: ${booking.checkin}
Check-out: ${booking.checkout}
Guests: ${booking.guests}
Total: $${booking.total_amount}
`;

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    });

    res.json({ message: "SMS sent successfully" });
  } catch (err) {
    console.error("SMS sending error:", err);
    res.status(500).json({ error: "Failed to send SMS" });
  }
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
