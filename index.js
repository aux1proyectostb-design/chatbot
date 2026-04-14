const express = require('express');
const xmlrpc  = require('xmlrpc');
const axios   = require('axios');
const { GoogleAuth } = require('google-auth-library');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
//  CONFIG ODOO
// =========================

const ODOO_URL      = 'https://telcobras-sas.odoo.com';
const ODOO_DB       = 'telcobras-sas';
const ODOO_USER     = 'operativo@telcobras.com';
const ODOO_PASSWORD = '18edc2e3ee7adab90ce6a0c57d5ca0c16731baca';

// =========================
//  CONFIG DIALOGFLOW
// =========================
const PROJECT_ID = 'chatbot-uyib';

const auth = new GoogleAuth({
    credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
        ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
        : undefined,
    keyFile: './credenciales.json',
    scopes: 'https://www.googleapis.com/auth/cloud-platform'
});


// =========================
//  ODOO
// =========================

function autenticarOdoo() {
    return new Promise((resolve, reject) => {
        const common = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/common` });

        common.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_PASSWORD, {}], (err, uid) => {
            if (err) return reject(err);
            if (!uid) return reject('Auth failed');
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
            if (err) return reject(err);
            resolve(res);
        });
    });
}

async function crearLead({ nombre, telefono, servicio, descripcion }) {
    const uid = await autenticarOdoo();

    return await ejecutarOdoo(uid, 'crm.lead', 'create', [{
        name: `Solicitud de ${servicio} - ${nombre}`,
        contact_name: nombre,
        phone: telefono || 'No registrado',
        description: `Servicio: ${servicio}
Detalle: ${descripcion}
Origen: Chatbot Telcobras`
    }]);
}

// =========================
//  DIALOGFLOW
// =========================

async function enviarADialogflow(texto, sessionId) {
    const client = await auth.getClient();
    const token  = await client.getAccessToken();

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
            Authorization: `Bearer ${token.token}`
        }
    });

    return response.data.queryResult;
}

// =========================
//  WHATSAPP → DIALOGFLOW → ODOO
// =========================

app.post('/whatsapp', async (req, res) => {
    const mensaje  = req.body.Body;
    const telefono = req.body.From;

    console.log("📲 WhatsApp:", mensaje);

    try {
        const df = await enviarADialogflow(mensaje, telefono);

        console.log("✅ Dialogflow OK:", df);

        const respuesta = df.fulfillmentText;

        res.set('Content-Type', 'text/xml');
        res.send(`
            <Response>
                <Message>${respuesta}</Message>
            </Response>
        `);

    } catch (error) {
        console.error("❌ ERROR DIALOGFLOW:", error.response?.data || error.message);

        res.set('Content-Type', 'text/xml');
        res.send(`
            <Response>
                <Message>Error conectando con el bot 🤖</Message>
            </Response>
        `);
    }
});

// =========================
//  HEALTH CHECK
// =========================

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// =========================
//  SERVER
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(` Servidor corriendo en puerto ${PORT}`);
});