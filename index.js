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
const SOPORTE_ALERTA = '573161966020';

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
const mensajesProcesados = new Set();
const SESION_TTL_MS = 30 * 60 * 1000;

function obtenerSesion(telefono) {

    const ahora = Date.now();

    if (!sesiones.has(telefono)) {
        sesiones.set(telefono, {
            historial: [],
            ultimaActividad: ahora
        });
    }

    const sesion = sesiones.get(telefono);

    if (ahora - sesion.ultimaActividad > SESION_TTL_MS) {
        sesion.historial = [];
    }

    sesion.ultimaActividad = ahora;

    return sesion;
}

// =========================
// PROMPT PRO
// =========================

const SYSTEM_PROMPT = `
Eres Teli, asesora virtual oficial de Telcobras SAS.

Empresa colombiana con sede en Cali y cobertura nacional.

Tu estilo:
- Profesional
- Corporativo
- Cercano
- Natural
- Sin emojis
- Sin sonar robótica
- Respuestas breves (máximo 3 líneas)

Horario:
Lunes a viernes de 7:30 a.m. a 5:00 p.m.
Sábados en horario laboral.

Servicios:
- Telecomunicaciones
- Redes empresariales
- Automatización industrial
- SCADA
- Sensores
- Soporte técnico remoto y en sitio
- Mantenimiento

Cuando un cliente salude responde:

Buen día, le saluda Teli de Telcobras SAS.

Con gusto le apoyaré. Por favor indíqueme la opción que desea gestionar:

1. Cotizaciones y ventas
2. Soporte técnico
3. Programar visita técnica
4. Información de servicios
5. Hablar con un asesor

También puede escribir directamente su necesidad.

Si detectas intención comercial:
Solicita nombre, empresa, ciudad, teléfono y necesidad.
Cuando tengas datos agrega:
##CREAR_LEAD##

Si detectas soporte:
Solicita nombre, empresa, ciudad, teléfono y descripción de la falla.

Clasifica prioridad:
Nivel 1 = operación detenida, sin internet total, planta parada, sistema caído.
Nivel 2 = falla parcial importante.
Nivel 3 = consulta menor o solicitud básica.

Cuando tengas datos agrega:
##CREAR_TICKET##

Si piden asesor humano:
Agrega:
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

function detectarPrioridad(descripcion = '') {

    const txt = descripcion.toLowerCase();

    const nivel1 = [
        'sin internet',
        'no hay internet',
        'caido',
        'caído',
        'planta parada',
        'servidor caido',
        'servidor caído',
        'red caida',
        'red caída',
        'sin servicio',
        'urgente'
    ];

    const nivel2 = [
        'lento',
        'lentitud',
        'intermitente',
        'error',
        'falla parcial',
        'camara dañada',
        'sensor fallando'
    ];

    if (nivel1.some(p => txt.includes(p))) {
        return { prioridad: '3', texto: 'NIVEL 1 CRITICO' };
    }

    if (nivel2.some(p => txt.includes(p))) {
        return { prioridad: '2', texto: 'NIVEL 2 IMPORTANTE' };
    }

    return { prioridad: '1', texto: 'NIVEL 3 NORMAL' };
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
        model: 'gemini-2.5-flash',
        contents: prompt
    });

    const respuesta = (result.text || '').trim();

    sesion.historial.push({ role: 'user', content: mensaje });
    sesion.historial.push({ role: 'model', content: respuesta });

    if (sesion.historial.length > 30) {
        sesion.historial = sesion.historial.slice(-30);
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
Extrae del chat:
nombre, telefono, empresa, ciudad, descripcion, servicio

Responde solo JSON válido.

${conversacion}
`;

    try {

        const result = await genAI.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt
        });

        return JSON.parse(result.text);

    } catch (error) {

        return {
            nombre: null,
            telefono: null,
            empresa: null,
            ciudad: null,
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
        description:
`${datos.descripcion}

Empresa: ${datos.empresa || 'No indica'}
Ciudad: ${datos.ciudad || 'No indica'}`
    }]);
}

async function crearTicket(datos) {

    const uid = await autenticarOdoo();

    return await ejecutarOdoo(uid, 'helpdesk.ticket', 'create', [{
        name: `${datos.prioridadTexto} - ${datos.nombre}`,
        partner_name: datos.nombre,
        partner_phone: datos.telefono,
        description:
`${datos.descripcion}

Empresa: ${datos.empresa || 'No indica'}
Ciudad: ${datos.ciudad || 'No indica'}`,
        priority: datos.prioridad
    }]);
}

// =========================
// ALERTA SOPORTE
// =========================

async function enviarAlertaSoporte(datos) {

    try {

        await axios.post(
            `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: SOPORTE_ALERTA,
                text: {
                    body:
`ALERTA ${datos.prioridadTexto}

Cliente: ${datos.nombre}
Telefono: ${datos.telefono}
Empresa: ${datos.empresa || 'No indica'}
Ciudad: ${datos.ciudad || 'No indica'}

Caso:
${datos.descripcion}

Revisar ticket en Odoo inmediatamente.`
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${META_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

    } catch (error) {
        console.error('Error alerta soporte:', error.response?.data || error.message);
    }
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

        const value = req.body.entry?.[0]?.changes?.[0]?.value;
        const message = value?.messages?.[0];

        if (!message) return res.sendStatus(200);
        if (value?.statuses) return res.sendStatus(200);
        if (message.type !== 'text') return res.sendStatus(200);

        if (mensajesProcesados.has(message.id)) {
            return res.sendStatus(200);
        }

        mensajesProcesados.add(message.id);
        setTimeout(() => mensajesProcesados.delete(message.id), 3600000);

        const now = Math.floor(Date.now() / 1000);
        const msgTime = Number(message.timestamp || 0);

        if (now - msgTime > 180) {
            return res.sendStatus(200);
        }

        const telefono = message.from;
        const mensaje = message.text?.body || '';

        console.log('WhatsApp recibido:', mensaje);

        const sesion = obtenerSesion(telefono);

        let respuestaRaw;

        try {
            respuestaRaw = await procesarMensaje(mensaje, sesion);
        } catch (error) {
            console.error(error.response?.data || error.message);
            respuestaRaw = 'Gracias por escribir a Telcobras. En breve uno de nuestros asesores le atenderá.';
        }

        const {
            crearLead,
            crearTicket,
            limpio: respuestaFinal
        } = extraerFlags(respuestaRaw);

        if (crearLead || crearTicket) {

            const datos = await extraerDatosConGemini(sesion.historial);

            if (crearLead) {

                await crearLead({
                    nombre: datos.nombre || 'Cliente',
                    telefono: datos.telefono || telefono,
                    empresa: datos.empresa,
                    ciudad: datos.ciudad,
                    servicio: datos.servicio || 'Comercial',
                    descripcion: datos.descripcion || 'Sin detalle'
                });
            }

            if (crearTicket) {

                const nivel = detectarPrioridad(datos.descripcion || '');

                const ticket = {
                    nombre: datos.nombre || 'Cliente',
                    telefono: datos.telefono || telefono,
                    empresa: datos.empresa,
                    ciudad: datos.ciudad,
                    descripcion: datos.descripcion || 'Sin detalle',
                    prioridad: nivel.prioridad,
                    prioridadTexto: nivel.texto
                };

                await crearTicket(ticket);

                if (nivel.prioridad === '3') {
                    await enviarAlertaSoporte(ticket);
                }
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