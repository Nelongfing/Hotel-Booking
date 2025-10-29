import express from "express";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// PORT
const PORT = process.env.PORT || 8080;

// Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

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

  fetch(url, options)
    .then((response) => response.json())
    .then((json) => {
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
    })
    .catch((err) => {
      console.error("Fetch error:", err);
      res.status(500).json({ error: "Failed to fetch hotels" });
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
        purchase_units: [
          { amount: { currency_code: "USD", value: total.toFixed(2) }, description: hotelName },
        ],
        application_context: {
          return_url: `${RAILWAY_URL}/success.html?bookingId=${bookingId}&email=${encodeURIComponent(
            email || "user@example.com"
          )}`,
          cancel_url: `${RAILWAY_URL}/cancel.html`,
        },
      }),
    });

    const orderData = await orderRes.json();
    const approveLink = orderData.links?.find((l) => l.rel === "approve")?.href;
    if (!approveLink) throw new Error("Missing PayPal approve link");

    res.json({ bookingId, approveUrl: approveLink });
  } catch (err) {
    console.error("❌ Create booking error:", err);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

// Confirm booking
app.post("/payments/webhook/paypal", async (req, res) => {
  const { bookingId } = req.body;
  if (!bookingId) return res.status(400).json({ error: "Missing bookingId" });

  try {
    await db.run(`UPDATE bookings SET status = ? WHERE id = ?`, ["confirmed", bookingId]);
    console.log(`✅ Booking ${bookingId} confirmed`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Booking confirmation error:", err);
    res.status(500).json({ error: "Failed to confirm booking" });
  }
});

// Send confirmation email with Resend
app.post("/notify/:bookingId", async (req, res) => {
  const { bookingId } = req.params;
  const { email } = req.body;

  try {
    const booking = await db.get(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const subject = `Booking Confirmed: ${booking.hotel_name}`;
    const html = `
      <h2>Booking Confirmed!</h2>
      <p><strong>Hotel:</strong> ${booking.hotel_name}</p>
      <p><strong>Check-in:</strong> ${booking.checkin}</p>
      <p><strong>Check-out:</strong> ${booking.checkout}</p>
      <p><strong>Guests:</strong> ${booking.guests}</p>
      <p><strong>Total:</strong> $${booking.total_amount}</p>
      <p>Status: ${booking.status}</p>
    `;

    const response = await resend.emails.send({
      from: "Hotel Booking <onboarding@resend.dev>",
      to: email,
      subject,
      html,
    });

    res.json({ message: "Email sent", response });
  } catch (err) {
    console.error("❌ Email send error:", err);
    res.status(500).json({ error: "Failed to send email" });
  }
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
