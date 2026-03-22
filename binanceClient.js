import crypto from "crypto";

const LIVE_BASE = "https://api.binance.com";
const TESTNET_BASE = "https://testnet.binance.vision";

function sign(query, secret) {
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

function parseText(text) {
  try { return text ? JSON.parse(text) : {}; }
  catch { return { raw: text }; }
}

function getBase(mode = "live") {
  return mode === "testnet" ? TESTNET_BASE : LIVE_BASE;
}

export async function pingBinance(mode = "live") {
  const res = await fetch(`${getBase(mode)}/api/v3/ping`);
  return await res.json();
}

export async function getServerTime(mode = "live") {
  const res = await fetch(`${getBase(mode)}/api/v3/time`);
  return await res.json();
}

export async function getTicker24h(symbol, mode = "live") {
  const res = await fetch(`${getBase(mode)}/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Ticker 24h non disponibile per ${symbol}`);
  return await res.json();
}

export async function getKlines(symbol, interval = "1h", limit = 200, mode = "live") {
  const res = await fetch(`${getBase(mode)}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`Klines non disponibili per ${symbol}`);
  return await res.json();
}

export async function getExchangeInfo(symbol, mode = "live") {
  const res = await fetch(`${getBase(mode)}/api/v3/exchangeInfo?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Exchange info non disponibile per ${symbol}`);
  return await res.json();
}

export function floorToStep(value, stepSize) {
  const step = Number(stepSize);
  if (!step || step <= 0) return Number(value);
  const precision = Math.max(0, (String(stepSize).split(".")[1] || "").replace(/0+$/, "").length);
  const floored = Math.floor(Number(value) / step) * step;
  return Number(floored.toFixed(precision));
}

export function formatToStep(value, stepSize) {
  const step = Number(stepSize);
  if (!step || step <= 0) return String(value);
  const precision = Math.max(0, (String(stepSize).split(".")[1] || "").replace(/0+$/, "").length);
  return floorToStep(value, stepSize).toFixed(precision);
}

export async function placeMarketOrder({ mode = "live", symbol, side, quantity, apiKey, apiSecret }) {
  const timestamp = Date.now();
  const query = new URLSearchParams({ symbol, side, type: "MARKET", quantity, timestamp }).toString();
  const signature = sign(query, apiSecret);
  const res = await fetch(`${getBase(mode)}/api/v3/order?${query}&signature=${signature}`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey }
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: parseText(text) };
}

export async function testMarketOrder({ mode = "live", symbol, side, quantity, apiKey, apiSecret }) {
  const timestamp = Date.now();
  const query = new URLSearchParams({ symbol, side, type: "MARKET", quantity, timestamp }).toString();
  const signature = sign(query, apiSecret);
  const res = await fetch(`${getBase(mode)}/api/v3/order/test?${query}&signature=${signature}`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey }
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: parseText(text) };
}
