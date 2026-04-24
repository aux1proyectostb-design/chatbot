const express = require('express');
const xmlrpc  = require('xmlrpc');
const axios   = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// CONFIG META WHATSAPP
// =========================

const META_TOKEN      = process.env.META_TOKEN;
const VERIFY_TOKEN    = 'telcobras2026';
const PHONE_NUMBER_ID = '1103131696212310';

// =========================
// CONFIG ODOO
// =========================

const ODOO_URL      = 'https://telcobras-sas.odoo.com';
const ODOO_DB       = 'telcobras-sas';
const ODOO_USER     = 'operativo@telcobras.com';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

// =========================
// CONFIG GEMINI
// =========================

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// =========================
// MEMORIA DE CONVERSACIONES
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

setInterval(() => {
    const ahora = Date.now();

    for (const [tel, sesion] of sesiones.entries()) {
        if (ahora - sesion.ultimaActividad > SESION_TTL_MS) {
            sesiones.delete(tel);
        }
    }
}, 10 * 60 * 1000);

// =========================
// SYSTEM PROMPT
// =========================

const SYSTEM_PROMPT = `Eres Teli, el asistente virtual de Telcobras SAS, empresa colombiana ubicada en Cali.

Hablas como asesor colombiano profesional y cercano.
Responde corto (máximo 3 líneas).

Servicios:
- Automatización industrial
- Telecomunicaciones
- Sensores
- Soporte técnico
- Redes
- Mantenimiento industrial

Si requieren soporte, pide:
1. Nombre
2. Número
3. Descripción del problema

Cuando ya tengas todo responde normalmente y agrega:
##CREAR_LEAD##

Si quieren asesor humano agrega:
##ESCALAR##`;

// =========================
// UTILIDADES
// =========================

function limpiarTelefono(numero) {
    return String(numero || '')
        .replace('whatsapp:', '')
        .replace('+', '')
        .trim();
}

function extraerFlags(texto) {
    return {
        crearLead: texto.includes('##CREAR_LEAD##'),
        escalar: texto.includes('##ESCALAR##'),
        limpio: texto
            .replace('##CREAR_LEAD##', '')
            .replace('##ESCALAR##', '')
            .trim()
    };
}

// =========================
// GEMINI
// =========================

async function procesarMensaje(mensaje, sesion) {

    const modelo = genAI.getGenerativeModel({
        model: "gemini-2.0-flash-lite",
        systemInstruction: SYSTEM_PROMPT
    });

    const historialGemini = sesion.historial.map(h => ({
        role: h.role,
        parts: [{ text: h.content }]
    }));

    const chat = modelo.startChat({
        history: historialGemini
    });

    const result = await chat.sendMessage(mensaje);
    const respuesta = result.response.text().trim();

    sesion.historial.push({ role: 'user', content: mensaje });
    sesion.historial.push({ role: 'model', content: respuesta });

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
Extrae del siguiente chat:
nombre, telefono, descripcion, servicio

Responde solo JSON válido.

${conversacion}
`;

    try {
        const modelo = genAI.getGenerativeModel({
            model: "gemini-2.0-flash-lite"
        });

        const result = await modelo.generateContent(prompt);

        const texto = result.response.text()
            .replace(/```json/g, '')
            .replace(/```/g, '')
            .trim();

        return JSON.parse(texto);

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

async function crearLead({ nombre, telefono, servicio, descripcion }) {

    const uid = await autenticarOdoo();

    return await ejecutarOdoo(uid, 'crm.lead', 'create', [{
        name: `Solicitud ${servicio} - ${nombre}`,
        contact_name: nombre,
        phone: telefono,
        description: descripcion
    }]);
}

// =========================
// WEBHOOK META VERIFICAR
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
// WEBHOOK META MENSAJES
// =========================

app.post('/webhook', async (req, res) => {

    try {

        const message =
            req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

        if (!message) {
            return res.sendStatus(200);
        }

        const telefono = message.from;
        const mensaje = message.text?.body || '';

        console.log('WhatsApp recibido:', mensaje);

        const sesion = obtenerSesion(telefono);

        const respuestaRaw = await procesarMensaje(mensaje, sesion);

        const {
            crearLead: debeCrearLead,
            limpio: respuestaFinal
        } = extraerFlags(respuestaRaw);

        if (debeCrearLead) {

            const datos = await extraerDatosConGemini(sesion.historial);

            await crearLead({
                nombre: datos.nombre || 'Cliente',
                telefono: datos.telefono || telefono,
                servicio: datos.servicio || 'soporte',
                descripcion: datos.descripcion || 'Sin detalle'
            });
        }

        await axios.post(
            `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
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
    res.json({
        ok: true,
        sesiones: sesiones.size
    });
});

// =========================
// SERVER
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor Telcobras activo en ${PORT}`);
});