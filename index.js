require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const path = require('path');
const { ocrSpace } = require('ocr-space-api-wrapper');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Explicit root route (needed for Vercel, since express.static() alone isn't used there)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Cloudinary configuration ----
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ---- MongoDB connection ----
const uri = process.env.MONGO_URI;
mongoose.connect(uri)
  .then(() => console.log("Connected to MongoDB Atlas!"))
  .catch((err) => console.error("Connection error:", err));

// ---- Schema ----
const landRecordSchema = new mongoose.Schema({
  record_id: String,
  user_name: String,
  user_contact: String,
  user_email: String,
  id_last4: String,
  state: String,
  district: String,
  tehsil: String,
  village: String,
  khasra_number: String,
  khata_number: String,
  area: String,
  land_type: String,
  ownership_type: String,
  registration_id: String,
  father_name: String,
  mother_name: String,
  father_id_last4: String,
  mother_id_last4: String,
  confidence: String,
  status: { type: String, default: "Pending" },
  rejection_reason: String,
  documents: [
    {
      document_type: String,
      original_name: String,
      url: String
    }
  ],
  submittedAt: { type: Date, default: Date.now }
});

const LandRecord = mongoose.model('LandRecord', landRecordSchema);

// ---- Simple admin authentication middleware ----
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized: invalid or missing admin key.' });
  }
  next();
}


// ---- File upload setup: store in MEMORY (not disk), then send to Cloudinary ----
const storage = multer.memoryStorage();
const upload = multer({ storage });

const documentFields = [
  { name: 'land_document' },
  { name: 'applicant_id_document' },
  { name: 'father_id_document' },
  { name: 'mother_id_document' },
  { name: 'registry_document' },
  { name: 'ror_document' },
  { name: 'mutation_document' },
  { name: 'inheritance_document' },
  { name: 'other_document' }
];

// Helper: upload a single file buffer to Cloudinary
function uploadToCloudinary(fileBuffer, folder) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'auto' },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    streamifier.createReadStream(fileBuffer).pipe(uploadStream);
  });
}

// ---- CREATE a record (Save / Save & Submit) ----
app.post('/api/records', upload.fields(documentFields), async (req, res) => {
  try {
    const body = req.body;
    const files = req.files || {};

    // Upload each file to Cloudinary and collect the resulting URLs
    const documents = [];
    for (const [fieldName, fileArray] of Object.entries(files)) {
      for (const file of fileArray) {
        const result = await uploadToCloudinary(file.buffer, 'bhurakshak_documents');
        documents.push({
          document_type: fieldName,
          original_name: file.originalname,
          url: result.secure_url
        });
      }
    }

    const record_id = "REC-" + new Date().getFullYear() + "-" + Math.floor(1000 + Math.random() * 9000);
    const status = body.submit_action === "save" ? "Draft" : "Pending";

    const record = new LandRecord({
      record_id,
      user_name: body.user_name,
      user_contact: body.user_contact,
      user_email: body.user_email,
      id_last4: body.id_last4,
      state: body.state,
      district: body.district,
      tehsil: body.tehsil,
      village: body.village,
      khasra_number: body.khasra_number,
      khata_number: body.khata_number,
      area: body.area,
      land_type: body.land_type,
      ownership_type: body.ownership_type,
      registration_id: body.registration_id,
      father_name: body.father_name,
      mother_name: body.mother_name,
      father_id_last4: body.father_id_last4,
      mother_id_last4: body.mother_id_last4,
      confidence: body.confidence,
      status,
      documents
    });

    await record.save();

    res.json({
      success: true,
      message: "Record saved successfully!",
      record: {
        id: record._id,
        record_id: record.record_id,
        user_name: record.user_name,
        state: record.state,
        district: record.district,
        village: record.village,
        khasra_number: record.khasra_number
      },
      documents
    });
  } catch (err) {
    console.error("SAVE RECORD ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to save record: " + err.message });
  }
});

// ---- LIST all records ----
app.get('/api/records', async (req, res) => {
  try {
    const records = await LandRecord.find().sort({ submittedAt: -1 });
    res.json(records.map(r => ({
      id: r._id,
      record_id: r.record_id,
      user_name: r.user_name,
      khasra_number: r.khasra_number,
      area: r.area,
      village: r.village,
      district: r.district,
      state: r.state,
      status: r.status,
      confidence: r.confidence
    })));
  } catch (err) {
    console.error("LIST RECORDS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to load records" });
  }
});

// ---- STATS ----
app.get('/api/stats', async (req, res) => {
  try {
    const total = await LandRecord.countDocuments();
    const pending = await LandRecord.countDocuments({ status: "Pending" });
    const verified = await LandRecord.countDocuments({ status: "Verified" });
    const documents = await LandRecord.aggregate([
      { $project: { count: { $size: { $ifNull: ["$documents", []] } } } },
      { $group: { _id: null, total: { $sum: "$count" } } }
    ]);
    res.json({
      total,
      pending,
      verified,
      documents: documents[0]?.total || 0
    });
  } catch (err) {
    console.error("STATS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to load stats" });
  }
});

// ---- SINGLE record (for verification modal) ----
app.get('/api/admin/records/:id', requireAdminKey, async (req, res) => {
  try {
    const record = await LandRecord.findById(req.params.id);
    if (!record) return res.status(404).json({ success: false, message: "Record not found." });
    res.json({ record, documents: record.documents || [] });
  } catch (err) {
    console.error("GET RECORD ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to load record" });
  }
});

// ---- UPDATE status (approve/reject) ----
app.put('/api/admin/records/:id/status', requireAdminKey, async (req, res) => {
  try {
    const { status, rejection_reason } = req.body;
    const record = await LandRecord.findByIdAndUpdate(
      req.params.id,
      { status, rejection_reason },
      { new: true }
    );
    if (!record) return res.status(404).json({ success: false, message: "Record not found." });
    res.json({ success: true, record });
  } catch (err) {
    console.error("UPDATE STATUS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to update status" });
  }
});


// ---- Helper: extract land-record fields from raw OCR text using pattern matching ----
function extractFieldsFromText(text) {
  const fields = {};
  const clean = text.replace(/\r/g, '');

  const patterns = {
    khasra_number: /khasra\s*(?:number|no\.?|\/)?\s*[:\-]?\s*([0-9\/-]+)/i,
    khata_number: /khata\s*(?:number|no\.?)?\s*[:\-]?\s*([0-9\/-]+)/i,
    village: /village\s*[:\-]?\s*([a-zA-Z\u0900-\u097F\s]+)/i,
    district: /district\s*[:\-]?\s*([a-zA-Z\u0900-\u097F\s]+)/i,
    state: /state\s*[:\-]?\s*([a-zA-Z\u0900-\u097F\s]+)/i,
    area: /area\s*[:\-]?\s*([0-9.]+\s*(?:hectare|acre|sq\.?\s?ft|ha)?)/i,
    registration_id: /registration\s*(?:id|no\.?)?\s*[:\-]?\s*([a-zA-Z0-9\-\/]+)/i,
    user_name: /(?:name|owner|landowner)\s*[:\-]?\s*([a-zA-Z\u0900-\u097F\s]+)/i
  };

  for (const [key, regex] of Object.entries(patterns)) {
    const match = clean.match(regex);
    if (match && match[1]) {
      fields[key] = match[1].trim().split('\n')[0].slice(0, 60);
    }
  }

  return fields;
}

// ---- AI / OCR EXTRACTION ROUTE ----
app.post('/api/ai/extract', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No document uploaded." });
    }

    const base64File = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    const ocrResult = await ocrSpace(base64File, {
      apiKey: process.env.OCR_SPACE_API_KEY,
      language: 'eng',
      OCREngine: '2'
    });

    const parsedText = ocrResult?.ParsedResults?.[0]?.ParsedText || '';

    if (!parsedText.trim()) {
      return res.json({ success: true, fields: {}, confidence: "Low", text: "" });
    }

    const fields = extractFieldsFromText(parsedText);
    const fieldCount = Object.keys(fields).length;
    const confidence = fieldCount >= 4 ? "High (" + (85 + fieldCount) + "%)" : fieldCount >= 1 ? "Medium (60%)" : "Low";

    res.json({
      success: true,
      fields,
      confidence,
      text: parsedText
    });
  } catch (err) {
    console.error("AI EXTRACTION ERROR:", err);
    res.status(500).json({ success: false, message: "AI extraction failed: " + err.message });
  }
});


// ---- QR CODE: generate a QR image linking to the public verification page ----
app.get('/api/records/:id/qrcode', async (req, res) => {
  try {
    const record = await LandRecord.findById(req.params.id);
    if (!record) return res.status(404).json({ success: false, message: "Record not found." });

    const verifyUrl = `${req.protocol}://${req.get('host')}/verify/${record._id}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 300, margin: 2 });

    res.json({ success: true, qrCode: qrDataUrl, verifyUrl });
  } catch (err) {
    console.error("QR CODE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to generate QR code." });
  }
});

// ---- PUBLIC VERIFICATION PAGE (safe, non-sensitive info only) ----
app.get('/verify/:id', async (req, res) => {
  try {
    const record = await LandRecord.findById(req.params.id);
    if (!record) {
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
          <h2>Record Not Found</h2>
          <p>This QR code does not match any record in the system.</p>
        </body></html>
      `);
    }

    const statusColor = record.status === "Verified" ? "#16a34a" : record.status === "Rejected" ? "#dc2626" : "#d97706";

    res.send(`
      <html>
      <head>
        <title>BhuRakshak Verification - ${record.record_id}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family:sans-serif; max-width:480px; margin:40px auto; padding:0 20px;">
        <div style="background:#7f1d1d; color:#fff; text-align:center; padding:10px; border-radius:8px; margin-bottom:20px; font-size:13px;">
          ⚠️ SIH 2026 Prototype - Not an official Government verification system
        </div>
        <h2 style="margin-bottom:4px;">BhuRakshak Record Verification</h2>
        <p style="color:#666;">Record ID: <b>${record.record_id}</b></p>
        <div style="background:${statusColor}; color:#fff; display:inline-block; padding:6px 14px; border-radius:20px; font-weight:600; margin-bottom:20px;">
          ${record.status}
        </div>
        <table style="width:100%; border-collapse:collapse; margin-top:10px;">
          <tr><td style="padding:8px 0; color:#666;">Village</td><td style="padding:8px 0; font-weight:600;">${record.village || '-'}</td></tr>
          <tr><td style="padding:8px 0; color:#666;">District</td><td style="padding:8px 0; font-weight:600;">${record.district || '-'}</td></tr>
          <tr><td style="padding:8px 0; color:#666;">State</td><td style="padding:8px 0; font-weight:600;">${record.state || '-'}</td></tr>
          <tr><td style="padding:8px 0; color:#666;">Khasra Number</td><td style="padding:8px 0; font-weight:600;">${record.khasra_number || '-'}</td></tr>
          <tr><td style="padding:8px 0; color:#666;">Land Type</td><td style="padding:8px 0; font-weight:600;">${record.land_type || '-'}</td></tr>
        </table>
        <p style="margin-top:24px; font-size:12px; color:#999;">This is a demo verification page for a student hackathon project. No personal identity information is displayed here.</p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("VERIFY PAGE ERROR:", err);
    res.status(500).send("Error loading verification page.");
  }
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));