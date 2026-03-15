const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig() {
  return {
    port: Number(process.env.ORCHESTRATOR_PORT || 3000),
    paymentUrl: readRequiredEnv('PAYMENT_URL'),
    inventoryUrl: readRequiredEnv('INVENTORY_URL'),
    shippingUrl: readRequiredEnv('SHIPPING_URL'),
    notificationUrl: readRequiredEnv('NOTIFICATION_URL'),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 2500)
  };
}

const config = loadConfig();

const DATA_DIR = '/data';
const IDEMPOTENCY_STORE_PATH = path.join(DATA_DIR, 'idempotency-store.json');
const SAGA_STORE_PATH = path.join(DATA_DIR, 'saga-store.json');

function ensureJsonFile(filePath, initialData) {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), 'utf8');
  }
}

function readJsonFile(filePath) {
  ensureJsonFile(filePath, {});
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw || '{}');
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function payloadHash(payload) {
  const normalized = JSON.stringify(payload);
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `sha256:${hash}`;
}

function validateCheckoutPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'Request body must be a JSON object';
  }
  if (typeof payload.orderId !== 'string' || payload.orderId.trim() === '') {
    return 'Field "orderId" is required and must be a non-empty string';
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return 'Field "items" is required and must be a non-empty array';
  }
  if (typeof payload.amount !== 'number') {
    return 'Field "amount" is required and must be numeric';
  }
  if (typeof payload.recipient !== 'string' || payload.recipient.trim() === '') {
    return 'Field "recipient" is required and must be a non-empty string';
  }
  return null;
}

function bootstrapStores() {
  ensureJsonFile(IDEMPOTENCY_STORE_PATH, { records: {} });
  ensureJsonFile(SAGA_STORE_PATH, { sagas: {} });
}

function upsertIdempotencyRecord(idempotencyKey, record) {
  const store = readJsonFile(IDEMPOTENCY_STORE_PATH);
  if (!store.records) {
    store.records = {};
  }
  store.records[idempotencyKey] = {
    ...record,
    updatedAt: nowIso()
  };
  writeJsonFile(IDEMPOTENCY_STORE_PATH, store);
}

function upsertSagaRecord(orderId, idempotencyKey, state, steps) {
  const store = readJsonFile(SAGA_STORE_PATH);
  if (!store.sagas) {
    store.sagas = {};
  }
  store.sagas[orderId] = {
    idempotencyKey,
    state,
    steps,
    updatedAt: nowIso()
  };
  writeJsonFile(SAGA_STORE_PATH, store);
}

function isTimeoutError(err) {
  return err?.code === 'ECONNABORTED' || err?.message?.toLowerCase?.().includes('timeout');
}

function responseCode(response, fallback = 'downstream_error') {
  return response?.data?.code || fallback;
}

function pushTrace(trace, step, status, startedAt, finishedAt, durationMs) {
  trace.push({
    step,
    status,
    startedAt,
    finishedAt,
    durationMs
  });
}

async function callStep({ trace, step, url, payload, headers }) {
  const startedAt = nowIso();
  const startedMs = nowMs();
  try {
    const response = await axios.post(url, payload, {
      headers,
      timeout: config.requestTimeoutMs,
      validateStatus: () => true
    });

    const finishedAt = nowIso();
    const durationMs = Math.max(0, nowMs() - startedMs);

    if (response.status >= 200 && response.status < 300) {
      pushTrace(trace, step, 'success', startedAt, finishedAt, durationMs);
      return { ok: true, response };
    }

    const status = response.status === 408 || response.status === 504 ? 'timeout' : 'failed';
    pushTrace(trace, step, status, startedAt, finishedAt, durationMs);
    return {
      ok: false,
      type: status === 'timeout' ? 'timeout' : 'business',
      response
    };
  } catch (err) {
    const finishedAt = nowIso();
    const durationMs = Math.max(0, nowMs() - startedMs);
    const timeout = isTimeoutError(err);
    pushTrace(trace, step, timeout ? 'timeout' : 'error', startedAt, finishedAt, durationMs);
    return {
      ok: false,
      type: timeout ? 'timeout' : 'business',
      error: err
    };
  }
}

async function runCompensation({ trace, orderId, headers, releaseInventory, refundPayment }) {
  if (releaseInventory) {
    const releaseResult = await callStep({
      trace,
      step: 'inventory_release',
      url: `${config.inventoryUrl}/inventory/release`,
      payload: { orderId },
      headers
    });
    if (!releaseResult.ok) {
      return { ok: false, failedStep: 'inventory_release' };
    }
  }

  if (refundPayment) {
    const refundResult = await callStep({
      trace,
      step: 'payment_refund',
      url: `${config.paymentUrl}/payment/refund`,
      payload: { orderId },
      headers
    });
    if (!refundResult.ok) {
      return { ok: false, failedStep: 'payment_refund' };
    }
  }

  return { ok: true };
}

function checkoutResponse(orderId, status, trace, code, message) {
  const response = {
    orderId,
    status,
    trace
  };
  if (code) {
    response.code = code;
  }
  if (message) {
    response.message = message;
  }
  return response;
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/debug/trace/:orderId', (req, res) => {
  const sagaStore = readJsonFile(SAGA_STORE_PATH);
  const saga = sagaStore?.sagas?.[req.params.orderId];
  if (!saga) {
    res.status(404).json({ code: 'not_found', message: 'No saga found for this orderId' });
    return;
  }
  res.status(200).json(saga);
});

app.post('/checkout', async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey) {
    res.status(400).json({
      code: 'validation_error',
      message: 'Idempotency-Key header is required'
    });
    return;
  }

  const validationError = validateCheckoutPayload(req.body);
  if (validationError) {
    res.status(400).json({
      code: 'validation_error',
      message: validationError
    });
    return;
  }

  const requestHash = payloadHash(req.body);
  const idempotencyStore = readJsonFile(IDEMPOTENCY_STORE_PATH);
  if (!idempotencyStore.records) {
    idempotencyStore.records = {};
  }

  const existing = idempotencyStore.records[idempotencyKey];
  if (existing) {
    if (existing.requestHash !== requestHash) {
      res.status(409).json({
        code: 'idempotency_payload_mismatch',
        message: 'This Idempotency-Key is already used for a different payload'
      });
      return;
    }

    if (existing.state === 'in_progress') {
      res.status(409).json({
        code: 'idempotency_conflict',
        message: 'An operation with this Idempotency-Key is already in progress'
      });
      return;
    }

    res.status(existing.httpStatus || 200).json(existing.response || {});
    return;
  }

  const orderId = req.body.orderId;
  upsertIdempotencyRecord(idempotencyKey, {
    requestHash,
    state: 'in_progress',
    httpStatus: 202,
    response: {
      orderId,
      status: 'in_progress'
    }
  });

  const trace = [];
  const callHeaders = {
    'x-correlation-id': idempotencyKey,
    'x-order-id': orderId
  };

  const success = {
    payment: false,
    inventory: false,
    shipping: false
  };

  function finalize(httpStatus, state, responseBody) {
    upsertSagaRecord(orderId, idempotencyKey, state, trace);
    upsertIdempotencyRecord(idempotencyKey, {
      requestHash,
      state,
      httpStatus,
      response: responseBody
    });
    res.status(httpStatus).json(responseBody);
  }

  const paymentResult = await callStep({
    trace,
    step: 'payment',
    url: `${config.paymentUrl}/payment/authorize`,
    payload: {
      orderId,
      amount: req.body.amount
    },
    headers: callHeaders
  });

  if (!paymentResult.ok) {
    if (paymentResult.type === 'timeout') {
      finalize(504, 'failed', checkoutResponse(orderId, 'failed', trace, 'timeout'));
      return;
    }
    finalize(
      422,
      'failed',
      checkoutResponse(orderId, 'failed', trace, responseCode(paymentResult.response, 'payment_failed'))
    );
    return;
  }
  success.payment = true;

  const inventoryResult = await callStep({
    trace,
    step: 'inventory',
    url: `${config.inventoryUrl}/inventory/reserve`,
    payload: {
      orderId,
      items: req.body.items
    },
    headers: callHeaders
  });

  if (!inventoryResult.ok) {
    const compensation = await runCompensation({
      trace,
      orderId,
      headers: callHeaders,
      releaseInventory: false,
      refundPayment: success.payment
    });

    if (!compensation.ok) {
      finalize(
        422,
        'failed',
        checkoutResponse(orderId, 'failed', trace, 'compensation_failed', `Compensation step failed: ${compensation.failedStep}`)
      );
      return;
    }

    if (inventoryResult.type === 'timeout') {
      finalize(504, 'compensated', checkoutResponse(orderId, 'compensated', trace, 'timeout'));
      return;
    }

    finalize(
      422,
      'compensated',
      checkoutResponse(orderId, 'compensated', trace, responseCode(inventoryResult.response, 'inventory_failed'))
    );
    return;
  }
  success.inventory = true;

  const shippingResult = await callStep({
    trace,
    step: 'shipping',
    url: `${config.shippingUrl}/shipping/create`,
    payload: {
      orderId
    },
    headers: callHeaders
  });

  if (!shippingResult.ok) {
    const compensation = await runCompensation({
      trace,
      orderId,
      headers: callHeaders,
      releaseInventory: success.inventory,
      refundPayment: success.payment
    });

    if (!compensation.ok) {
      finalize(
        422,
        'failed',
        checkoutResponse(orderId, 'failed', trace, 'compensation_failed', `Compensation step failed: ${compensation.failedStep}`)
      );
      return;
    }

    if (shippingResult.type === 'timeout') {
      finalize(504, 'compensated', checkoutResponse(orderId, 'compensated', trace, 'timeout'));
      return;
    }

    finalize(
      422,
      'compensated',
      checkoutResponse(orderId, 'compensated', trace, responseCode(shippingResult.response, 'shipping_failed'))
    );
    return;
  }
  success.shipping = true;

  const notificationResult = await callStep({
    trace,
    step: 'notification',
    url: `${config.notificationUrl}/notification/send`,
    payload: {
      orderId,
      recipient: req.body.recipient
    },
    headers: callHeaders
  });

  if (!notificationResult.ok) {
    const compensation = await runCompensation({
      trace,
      orderId,
      headers: callHeaders,
      releaseInventory: success.inventory,
      refundPayment: success.payment
    });

    if (!compensation.ok) {
      finalize(
        422,
        'failed',
        checkoutResponse(orderId, 'failed', trace, 'compensation_failed', `Compensation step failed: ${compensation.failedStep}`)
      );
      return;
    }

    if (notificationResult.type === 'timeout') {
      finalize(504, 'compensated', checkoutResponse(orderId, 'compensated', trace, 'timeout'));
      return;
    }

    finalize(
      422,
      'compensated',
      checkoutResponse(orderId, 'compensated', trace, responseCode(notificationResult.response, 'notification_failed'))
    );
    return;
  }

  finalize(200, 'completed', checkoutResponse(orderId, 'completed', trace));
});

bootstrapStores();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[orchestrator] listening on port ${config.port}`);
  console.log('[orchestrator] downstream targets loaded from env', {
    paymentUrl: config.paymentUrl,
    inventoryUrl: config.inventoryUrl,
    shippingUrl: config.shippingUrl,
    notificationUrl: config.notificationUrl,
    requestTimeoutMs: config.requestTimeoutMs
  });
});

