const express = require('express');
const xmlrpc  = require('xmlrpc');
const axios   = require('axios');
const twilio  = require('twilio');
const { GoogleAuth } = require('google-auth-library');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// CONFIG ODOO
// =========================

const ODOO_URL      = 'https://telcobras-sas.odoo.com';
const ODOO_DB       = 'telcobras-sas';
const ODOO_USER     = 'operativo@telcobras.com';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

// =========================
// CONFIG DIALOGFLOW
// =========================

const PROJECT_ID = 'chatbot-uyib';

const auth = new GoogleAuth({
    keyFile: './credenciales.json',
    scopes: 'https://www.googleapis.com/auth/cloud-platform'
});

// =========================
// UTILIDADES
// =========================

function limpiarTelefono(numero) {
    return String(numero || '')
        .replace('whatsapp:', '')
        .replace('+', '')
        .trim();
}

// =========================
// ODOO
// =========================

async function autenticarOdoo() {
    const common = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/common` });

    return new Promise((resolve, reject) => {
        common.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_PASSWORD, {}], (err, uid) => {
            if (err) {
                console.error("Error conexión Odoo:", err);
                return reject(err);
            }
            if (!uid) {
                return reject("Autenticación fallida en Odoo");
            }
            console.log("UID Odoo:", uid);
            resolve(uid);
        });
    });
}

function ejecutarOdoo(uid, modelo, metodo, args) {
    return new Promise((resolve, reject) => {
        const models = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/object` });

        models.methodCall('execute_kw', [
            ODOO_DB,
            uid,
            ODOO_PASSWORD,
            modelo,
            metodo,
            args
        ], (err, res) => {
            if (err) {
                console.error("Error en método Odoo:", err);
                return reject(err);
            }
            resolve(res);
        });
    });
}

async function crearLead({ nombre, telefono, servicio, descripcion }) {
    const uid = await autenticarOdoo();

    const telefonoLimpio = limpiarTelefono(telefono);

    console.log("Datos enviados a Odoo:", { nombre, telefono: telefonoLimpio, servicio, descripcion });

    const leadId = await ejecutarOdoo(uid, 'crm.lead', 'create', [{
        name: `Solicitud de ${servicio} - ${nombre}`,
        contact_name: nombre,
        phone: telefonoLimpio || 'No registrado',
        description: `Servicio: ${servicio}\nDetalle: ${descripcion}\nOrigen: Chatbot Telcobras`
    }]);

    return leadId;
}

// =========================
// DIALOGFLOW
// =========================

async function enviarADialogflow(texto, sessionId) {
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token = tokenResponse.token;

    const url = `https://dialogflow.googleapis.com/v2/projects/${PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`;

    const response = await axios.post(url, {
        queryInput: {
            text: {
                text: texto,
                languageCode: 'es'
            }
        }
    }, {
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    return response.data.queryResult;
}

// =========================
// EXTRAER DATOS DE CONTEXTOS
// =========================

function extraerDatos(df) {
    const data = {
        nombre:      undefined,
        telefono:    undefined,
        descripcion: undefined
    };

    const params = df.parameters || {};

    if (params.nombre)      data.nombre      = params.nombre;
    if (params.telefono)    data.telefono    = params.telefono;
    if (params.descripcion) data.descripcion = params.descripcion;

    if (df.outputContexts) {
        for (const ctx of df.outputContexts) {
            const p = ctx.parameters || {};
            if (!data.nombre      && p.nombre)      data.nombre      = p.nombre;
            if (!data.telefono    && p.telefono)     data.telefono    = p.telefono;
            if (!data.descripcion && p.descripcion)  data.descripcion = p.descripcion;
        }
    }

    return data;
}

// =========================
// RUTA WHATSAPP
// =========================

app.post('/whatsapp', async (req, res) => {
    const MessagingResponse = twilio.twiml.MessagingResponse;
    const twiml = new MessagingResponse();

    const mensaje  = req.body.Body;
    const telefono = req.body.From;

    console.log("WhatsApp recibido:", mensaje, "| De:", telefono);

    try {
        const df = await enviarADialogflow(mensaje, telefono);

        console.log("Intent detectado:", df.intent.displayName);

        let respuesta = df.fulfillmentText || "No entendí tu mensaje";
        respuesta = respuesta.replace(/\n/g, ' ').trim();

        const datos = extraerDatos(df);
        console.log("Datos extraídos:", datos);

        if (df.intent.displayName === 'soporte_descripcion') {
            try {
                console.log("Creando lead en Odoo...");
                const leadId = await crearLead({
                    nombre:      datos.nombre      || 'Cliente',
                    telefono:    datos.telefono    || telefono,
                    servicio:    'soporte',
                    descripcion: datos.descripcion || 'Sin descripcion'
                });
                console.log("Lead creado, ID:", leadId);
            } catch (err) {
                console.error("ERROR creando lead en Odoo:", err);
            }
        }

        twiml.message(respuesta);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(twiml.toString());

    } catch (error) {
        console.error("ERROR GENERAL:", error);
        twiml.message("Error procesando tu solicitud. Intenta de nuevo.");
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(twiml.toString());
    }
});

// =========================
// HEALTH CHECK
// =========================

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// =========================
// SERVER
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});