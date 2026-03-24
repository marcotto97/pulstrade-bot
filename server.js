import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  pingBinance,
  getServerTime,
  getTicker24h,
  getKlines,
  getExchangeInfo,
  floorToStep,
  formatToStep,
  placeMarketOrder,
  testMarketOrder
} from "./binanceClient.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const MIN_SCORE_ALERT = Number(process.env.MIN_SCORE_ALERT || 68);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_SECONDS || 60) * 1000;
const TRADE_AMOUNT_EUR = Number(process.env.TRADE_AMOUNT_EUR || 10);
const RISK_PERCENT = Number(process.env.RISK_PERCENT || 1);

const BINANCE_MODE = String(process.env.BINANCE_MODE || "live").toLowerCase();
const LIVE_TRADING_ENABLED = String(process.env.LIVE_TRADING_ENABLED || "false").toLowerCase() === "true";
const AUTO_BUY_LIVE = String(process.env.AUTO_BUY_LIVE || "false").toLowerCase() === "true";

const ASSETS = ["bitcoin", "ethereum"];
const SYMBOL_MAP = { bitcoin: "BTCUSDC", ethereum: "ETHUSDC", solana: "SOLUSDC", ripple: "XRPUSDC" };

let monitor = { running: false, timer: null, lastScanAt: null, logs: [], lastSignals: [], sentAlerts: {}, openPositions: [] };

function log(message, type = "info") {
  monitor.logs.unshift({ time: new Date().toLocaleTimeString("it-IT"), type, message });
  monitor.logs = monitor.logs.slice(0, 300);
}
function telegramConfigured() { return !!TOKEN && !!CHAT_ID; }
function getApiCreds() {
  return { mode: BINANCE_MODE, apiKey: process.env.BINANCE_API_KEY || "", apiSecret: process.env.BINANCE_API_SECRET || "" };
}
function binanceConfigured() {
  const { apiKey, apiSecret } = getApiCreds();
  return !!apiKey && !!apiSecret;
}
async function sendTelegramMessage(message) {
  if (!telegramConfigured()) throw new Error("Telegram non configurato");
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

function sma(arr, p) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= p) sum -= arr[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}
function rsi(arr, p = 14) {
  const out = new Array(arr.length).fill(null);
  if (arr.length <= p) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) {
    const ch = arr[i] - arr[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / p, avgLoss = loss / p;
  out[p] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = p + 1; i < arr.length; i++) {
    const ch = arr[i] - arr[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = ((avgGain * (p - 1)) + g) / p;
    avgLoss = ((avgLoss * (p - 1)) + l) / p;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
function momentum(arr, p = 10) {
  const out = new Array(arr.length).fill(null);
  for (let i = p; i < arr.length; i++) out[i] = arr[i] - arr[i - p];
  return out;
}
function approxATR(prices, p = 14) {
  const diffs = prices.map((x, i) => i === 0 ? 0 : Math.abs(x - prices[i - 1]));
  return sma(diffs, p);
}
function fmt(n, d = 2) {
  return Number(n).toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d });
}

async function fetchAsset(asset, interval = "1h", limit = 200) {
  const symbol = SYMBOL_MAP[asset];
  if (!symbol) throw new Error(`Simbolo Binance non disponibile per ${asset}`);
  const [ticker, klines] = await Promise.all([
    getTicker24h(symbol, "live"),
    getKlines(symbol, interval, limit, "live")
  ]);
  return { asset, symbol, price: Number(ticker.lastPrice), prices: klines.map(k => Number(k[4])) };
}

function computeSignal(data, tradeAmount = TRADE_AMOUNT_EUR, riskPct = RISK_PERCENT, minScore = MIN_SCORE_ALERT) {
  const prices = data.prices;
  const close = prices[prices.length - 1];
  const sma20 = sma(prices, 20);
  const sma50 = sma(prices, 50);
  const rsiArr = rsi(prices, 14);
  const mom = momentum(prices, 10);
  const atr = approxATR(prices, 14);

  const s20 = sma20[sma20.length - 1];
  const s50 = sma50[sma50.length - 1];
  const r = rsiArr[rsiArr.length - 1];
  const m = mom[mom.length - 1];
  const a = atr[atr.length - 1] || close * 0.01;

  let score = 50;
  const reasons = [];
  if (close > s20) { score += 10; reasons.push("prezzo sopra SMA20"); } else { score -= 10; reasons.push("prezzo sotto SMA20"); }
  if (s20 > s50) { score += 12; reasons.push("trend medio rialzista"); } else { score -= 12; reasons.push("trend medio debole"); }
  if (r > 54 && r < 70) { score += 10; reasons.push("RSI costruttivo"); }
  if (r >= 70) { score -= 7; reasons.push("zona calda"); }
  if (r < 45) { score -= 8; reasons.push("RSI fragile"); }
  if (m > 0) { score += 10; reasons.push("momentum positivo"); } else { score -= 10; reasons.push("momentum negativo"); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const signal = score >= minScore ? "COMPRA" : "ATTENDI";
  const confidence = Math.max(55, Math.min(92, Math.round(52 + Math.abs(score - 50))));
  const stopDistance = Math.max(a, close * 0.01);
  const entry = close;
  const tp = close + stopDistance * 2;
  const sl = close - stopDistance;
  const size = tradeAmount / close;
  const riskValue = tradeAmount * (riskPct / 100);
  const profitValue = (tp - entry) * size;

  return { asset: data.asset, symbol: data.symbol, price: data.price, signal, score, confidence, rsi: r, entry, tp, sl, size, riskValue, profitValue, reasons };
}

async function scanSignals(interval = "1h", limit = 200, tradeAmount = TRADE_AMOUNT_EUR, riskPct = RISK_PERCENT, minScore = MIN_SCORE_ALERT) {
  const rows = [];
  for (const asset of ASSETS) {
    const data = await fetchAsset(asset, interval, limit);
    rows.push(computeSignal(data, tradeAmount, riskPct, minScore));
  }
  rows.sort((a, b) => b.score - a.score);
  monitor.lastSignals = rows;
  monitor.lastScanAt = new Date().toISOString();
  return rows;
}

function hasOpenPosition(asset) {
  return monitor.openPositions.some(p => p.asset === asset && p.status === "OPEN");
}
function getSymbolFilters(symbolInfo) {
  return {
    lotSize: symbolInfo.filters.find(f => f.filterType === "LOT_SIZE"),
    marketLotSize: symbolInfo.filters.find(f => f.filterType === "MARKET_LOT_SIZE"),
    minNotional: symbolInfo.filters.find(f => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL")
  };
}

async function buildValidMarketQuantity(signal) {
  const info = await getExchangeInfo(signal.symbol, BINANCE_MODE);
  const symbolInfo = info?.symbols?.[0];
  if (!symbolInfo) throw new Error(`exchangeInfo non disponibile per ${signal.symbol}`);

  const { lotSize, marketLotSize, minNotional } = getSymbolFilters(symbolInfo);
  const stepSize = marketLotSize?.stepSize || lotSize?.stepSize || "0.000001";
  const minQty = Number(marketLotSize?.minQty || lotSize?.minQty || 0);
  const minN = Number(minNotional?.minNotional || 0);

  let qtyNum = floorToStep(signal.size, stepSize);
  if (qtyNum < minQty) qtyNum = floorToStep(minQty, stepSize);
  if (minN > 0 && qtyNum * signal.entry < minN) {
    const needed = minN / signal.entry;
    qtyNum = floorToStep(needed + Number(stepSize), stepSize);
  }
  if (!qtyNum || qtyNum <= 0) throw new Error("Quantità non valida");

  const qty = formatToStep(qtyNum, stepSize);
  return { qty, qtyNum };
}

async function executeAutoBuy(signal, forceLive = false) {
  const { mode, apiKey, apiSecret } = getApiCreds();
  if (!binanceConfigured()) throw new Error("API Binance mancanti");
  if (!signal.symbol) throw new Error(`Simbolo Binance non disponibile per ${signal.asset}`);
  if (hasOpenPosition(signal.asset)) return { ok: false, skipped: true, reason: "Posizione già aperta" };

  if (mode === "live") {
    if (!LIVE_TRADING_ENABLED) return { ok: false, skipped: true, reason: "LIVE_TRADING_ENABLED=false" };
    if (!AUTO_BUY_LIVE && !forceLive) return { ok: false, skipped: true, reason: "AUTO_BUY_LIVE=false" };
  }

  const { qty, qtyNum } = await buildValidMarketQuantity(signal);

  const order = await placeMarketOrder({ mode, symbol: signal.symbol, side: "BUY", quantity: qty, apiKey, apiSecret });
  if (!order.ok) throw new Error(JSON.stringify(order.data));

  const position = {
    asset: signal.asset,
    symbol: signal.symbol,
    qty: qtyNum,
    entry: signal.entry,
    tp: signal.tp,
    sl: signal.sl,
    score: signal.score,
    confidence: signal.confidence,
    status: "OPEN",
    openedAt: new Date().toISOString(),
    orderId: order.data.orderId || null,
    mode
  };

  monitor.openPositions.push(position);

  const msg =
`🚀 BUY ${mode.toUpperCase()} ESEGUITO

Asset: ${signal.asset.toUpperCase()}
Simbolo: ${signal.symbol}
Qty: ${qty}
Entry stimata: ${fmt(signal.entry, 2)}
TP piano: ${fmt(signal.tp, 2)}
SL piano: ${fmt(signal.sl, 2)}
Score: ${signal.score}
Confidenza: ${signal.confidence}%`;

  if (telegramConfigured()) await sendTelegramMessage(msg);
  log(`BUY ${mode} eseguito su ${signal.symbol} qty ${qty}`, "good");
  return { ok: true, position };
}

async function monitoringCycle() {
  try {
    const rows = await scanSignals();
    for (const row of rows) {
      if (row.signal !== "COMPRA") continue;

      const priceBucket = Math.round(row.entry);
      const alertKey = `${row.asset}:${priceBucket}`;
      if (!monitor.sentAlerts[alertKey]) {
        monitor.sentAlerts[alertKey] = true;
        const text =
`📈 SEGNALE FORTE

Asset: ${row.asset.toUpperCase()}
Segnale: ${row.signal}
Prezzo: ${fmt(row.entry, 2)}
Score: ${row.score}
Confidenza: ${row.confidence}%
RSI: ${fmt(row.rsi, 1)}

TP: ${fmt(row.tp, 2)}
SL: ${fmt(row.sl, 2)}

Motivi:
- ${row.reasons.join("\n- ")}`;
        if (telegramConfigured()) await sendTelegramMessage(text);
        log(`Segnale forte su ${row.asset.toUpperCase()} a ${fmt(row.entry, 2)}`, "good");
      }

      if (!hasOpenPosition(row.asset)) {
        try {
          await executeAutoBuy(row, false);
        } catch (e) {
          log(`Errore auto buy ${row.asset}: ${e.message}`, "bad");
          if (telegramConfigured()) await sendTelegramMessage(`❌ Errore auto buy ${row.asset.toUpperCase()}\n${e.message}`);
        }
      }
    }
    if (!rows.some(r => r.signal === "COMPRA")) log("Nessun segnale forte in questo ciclo", "info");
  } catch (e) {
    log(`Errore monitoraggio: ${e.message}`, "bad");
  }
}

app.get("/api/state", (_req, res) => {
  res.json({
    ok: true,
    running: monitor.running,
    telegram: telegramConfigured(),
    binanceConfigured: binanceConfigured(),
    mode: BINANCE_MODE,
    liveEnabled: LIVE_TRADING_ENABLED,
    autoBuyLive: AUTO_BUY_LIVE,
    lastScanAt: monitor.lastScanAt,
    logs: monitor.logs,
    lastSignals: monitor.lastSignals,
    openPositions: monitor.openPositions
  });
});

app.get("/api/analyze", async (req, res) => {
  try {
    const asset = String(req.query.asset || "bitcoin");
    const interval = String(req.query.interval || "1h");
    const limit = Number(req.query.limit || 200);
    const tradeAmount = Number(req.query.tradeAmount || TRADE_AMOUNT_EUR);
    const riskPct = Number(req.query.riskPct || RISK_PERCENT);
    const minScore = Number(req.query.minScore || MIN_SCORE_ALERT);

    const data = await fetchAsset(asset, interval, limit);
    const signal = computeSignal(data, tradeAmount, riskPct, minScore);
    res.json({ ok: true, signal, prices: data.prices });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/start", async (_req, res) => {
  if (monitor.running) return res.json({ ok: true, message: "Monitor già attivo" });
  monitor.running = true;
  monitor.timer = setInterval(monitoringCycle, SCAN_INTERVAL_MS);
  log("Monitor segnali avviato", "good");
  try {
    if (telegramConfigured()) await sendTelegramMessage(`🚀 PulseTrade monitor avviato (${BINANCE_MODE})`);
  } catch (e) {
    log(`Errore Telegram avvio: ${e.message}`, "bad");
  }
  await monitoringCycle();
  res.json({ ok: true, message: "Monitor avviato" });
});

app.post("/api/stop", async (_req, res) => {
  if (monitor.timer) clearInterval(monitor.timer);
  monitor.timer = null;
  monitor.running = false;
  log("Monitor fermato", "warn");
  res.json({ ok: true, message: "Monitor fermato" });
});

app.post("/api/telegram/test", async (_req, res) => {
  try {
    await sendTelegramMessage("Test PulseTrade: Telegram collegato correttamente.");
    res.json({ ok: true, message: "Test inviato su Telegram" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/binance/ping", async (_req, res) => {
  try {
    const data = await pingBinance(BINANCE_MODE);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/binance/time", async (_req, res) => {
  try {
    const data = await getServerTime(BINANCE_MODE);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/binance/order-test", async (req, res) => {
  try {
    if (!binanceConfigured()) return res.status(400).json({ ok: false, error: "API Binance mancanti nel .env" });
    const { mode, apiKey, apiSecret } = getApiCreds();
    const data = await testMarketOrder({
      mode,
      symbol: req.body.symbol || "ETHUSDT",
      side: "BUY",
      quantity: req.body.quantity || "0.001",
      apiKey,
      apiSecret
    });
    res.status(data.ok ? 200 : 400).json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/binance/manual-buy", async (req, res) => {
  try {
    const asset = String(req.body.asset || "bitcoin");
    const interval = String(req.body.interval || "1h");
    const limit = Number(req.body.limit || 200);
    const tradeAmount = Number(req.body.tradeAmount || TRADE_AMOUNT_EUR);
    const riskPct = Number(req.body.riskPct || RISK_PERCENT);
    const minScore = Number(req.body.minScore || MIN_SCORE_ALERT);

    const data = await fetchAsset(asset, interval, limit);
    const signal = computeSignal(data, tradeAmount, riskPct, minScore);
    const result = await executeAutoBuy(signal, true);

    res.json({ ok: true, signal, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`PulseTrade Live Safe attivo su http://localhost:${PORT}`);
});
