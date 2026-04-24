const express = require('express');
const xmlrpc = require('xmlrpc');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// CONFIG META WHATSAPP
// =========================

const META_TOKEN = process.env.META_TOKEN;
const VERIFY_TOKEN = 'telcobras2026';
const PHONE_NUMBER_ID = '1052042771330730';

// =========================
// CONFIG ODOO
// =========================

const ODOO_URL = 'https://telcobras-sas.odoo.com';
const ODOO_DB = 'telcobras-sas';
const ODOO_USER = 'operativo@telcobras.com';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

// =========================
// CONFIG GEMINI
// =========================

const genAI = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

// =========================
// MEMORIA
// =========================

const sesiones = new Map();
const SESION_TTL_MS = 30 * 60 * 1000;

function obtenerSesion(telefono) {
    const ahora = Date.now();

    if (!sesiones.has(telefono)) {
        sesiones.set(telefono, {
            historial: [],
            datos: {
                nombre: null,
                telefono: null,
                descripcion: null,
                servicio: null
            },
            ultimaActividad: ahora
        });
    }

    const sesion = sesiones.get(telefono);

    if (ahora - sesion.ultimaActividad > SESION_TTL_MS) {
        sesion.historial = [];
        sesion.datos = {
            nombre: null,
            telefono: null,
            descripcion: null,
            servicio: null
        };
    }

    sesion.ultimaActividad = ahora;
    return sesion;
}

// =========================
// PROMPT
// =========================

const SYSTEM_PROMPT = `
Eres Teli, asistente virtual de Telcobras SAS en Cali, Colombia.

Hablas profesional, amable y corto.
Máximo 3 líneas por respuesta.

Servicios:
- Automatización industrial
- Telecomunicaciones
- Redes
- Sensores
- Soporte técnico
- Mantenimiento

Si quieren cotización, venta, visita o proyecto nuevo:
Pide nombre, teléfono y necesidad.
Cuando tengas datos agrega:
##CREAR_LEAD##

Si reportan daño, falla o soporte:
Pide nombre, teléfono y descripción.
Cuando tengas datos agrega:
##CREAR_TICKET##

Si quieren humano:
##ESCALAR##
`;

// =========================
// UTILIDADES
// =========================

function extraerFlags(texto) {
    return {
        crearLead: texto.includes('##CREAR_LEAD##'),
        crearTicket: texto.includes('##CREAR_TICKET##'),
        escalar: texto.includes('##ESCALAR##'),
        limpio: texto
            .replace('##CREAR_LEAD##', '')
            .replace('##CREAR_TICKET##', '')
            .replace('##ESCALAR##', '')
            .trim()
    };
}

// =========================
// IA
// =========================

async function procesarMensaje(mensaje, sesion) {

    const historial = sesion.historial
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

    const prompt = `
${SYSTEM_PROMPT}

Historial:
${historial}

Usuario: ${mensaje}
`;

    const result = await genAI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt
    });

    const respuesta = (result.text || '').trim();

    sesion.historial.push({ role: 'user', content: mensaje });
    sesion.historial.push({ role: 'model', content: respuesta });

    if (sesion.historial.length > 40) {
        sesion.historial = sesion.historial.slice(-40);
    }

    return respuesta;
}

// =========================
// EXTRAER DATOS
// =========================

async function extraerDatosConGemini(historial) {

    const conversacion = historial
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

    const prompt = `
Extrae nombre, telefono, descripcion y servicio.
Responde solo JSON válido.

${conversacion}
`;

    try {

        const result = await genAI.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt
        });

        return JSON.parse(result.text);

    } catch (error) {

        return {
            nombre: null,
            telefono: null,
            descripcion: null,
            servicio: null
        };
    }
}

// =========================
// ODOO
// =========================

async function autenticarOdoo() {

    const common = xmlrpc.createSecureClient({
        url: `${ODOO_URL}/xmlrpc/2/common`
    });

    return new Promise((resolve, reject) => {

        common.methodCall(
            'authenticate',
            [ODOO_DB, ODOO_USER, ODOO_PASSWORD, {}],
            (err, uid) => {
                if (err) return reject(err);
                resolve(uid);
            }
        );
    });
}

function ejecutarOdoo(uid, modelo, metodo, args) {

    return new Promise((resolve, reject) => {

        const models = xmlrpc.createSecureClient({
            url: `${ODOO_URL}/xmlrpc/2/object`
        });

        models.methodCall(
            'execute_kw',
            [ODOO_DB, uid, ODOO_PASSWORD, modelo, metodo, args],
            (err, res) => {
                if (err) return reject(err);
                resolve(res);
            }
        );
    });
}

async function crearLead(datos) {

    const uid = await autenticarOdoo();

    return await ejecutarOdoo(uid, 'crm.lead', 'create', [{
        name: `Solicitud ${datos.servicio || 'Comercial'} - ${datos.nombre}`,
        contact_name: datos.nombre,
        phone: datos.telefono,
        description: datos.descripcion
    }]);
}

async function crearTicket(datos) {

    const uid = await autenticarOdoo();

    return await ejecutarOdoo(uid, 'helpdesk.ticket', 'create', [{
        name: `Soporte - ${datos.nombre}`,
        partner_name: datos.nombre,
        partner_phone: datos.telefono,
        description: datos.descripcion
    }]);
}

// =========================
// WEBHOOK VERIFICAR
// =========================

app.get('/webhook', (req, res) => {

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
});

// =========================
// WEBHOOK MENSAJES
// =========================

app.post('/webhook', async (req, res) => {

    try {

        const message =
            req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

        if (!message) return res.sendStatus(200);

        const telefono = message.from;
        const mensaje = message.text?.body || '';

        console.log('WhatsApp recibido:', mensaje);

        const sesion = obtenerSesion(telefono);

        let respuestaRaw;

        try {
            respuestaRaw = await procesarMensaje(mensaje, sesion);
        } catch (error) {
            console.error(error.response?.data || error.message);
            respuestaRaw = 'Hola 👋 Gracias por escribir a Telcobras. Un asesor te responderá pronto.';
        }

        const {
            crearLead: debeLead,
            crearTicket: debeTicket,
            limpio: respuestaFinal
        } = extraerFlags(respuestaRaw);

        if (debeLead || debeTicket) {

            const datos = await extraerDatosConGemini(sesion.historial);

            if (debeLead) {
                await crearLead({
                    nombre: datos.nombre || 'Cliente',
                    telefono: datos.telefono || telefono,
                    servicio: datos.servicio || 'Comercial',
                    descripcion: datos.descripcion || 'Sin detalle'
                });
            }

            if (debeTicket) {
                await crearTicket({
                    nombre: datos.nombre || 'Cliente',
                    telefono: datos.telefono || telefono,
                    descripcion: datos.descripcion || 'Sin detalle'
                });
            }
        }

        await axios.post(
            `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: telefono,
                text: { body: respuestaFinal }
            },
            {
                headers: {
                    Authorization: `Bearer ${META_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return res.sendStatus(200);

    } catch (error) {

        console.error(error.response?.data || error.message);
        return res.sendStatus(500);
    }
});

// =========================
// HEALTH
// =========================

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

// =========================
// SERVER
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor Telcobras activo en ${PORT}`);
});