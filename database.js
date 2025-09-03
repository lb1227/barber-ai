import Database from "better-sqlite3";

// Create or open the database file
const db = new Database("barber-ai.db");

// Create a table for appointments if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    appointment_time TEXT NOT NULL
  )
`);

console.log("Database ready ✅");

export default db;
