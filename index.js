require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads')); // so document links work

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

// ---- File upload setup ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
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

// ---- CREATE a record (Save / Save & Submit) ----
app.post('/api/records', upload.fields(documentFields), async (req, res) => {
  try {
    const body = req.body;
    const files = req.files || {};

    const documents = Object.entries(files).flatMap(([fieldName, fileArray]) =>
      fileArray.map(file => ({
        document_type: fieldName,
        original_name: file.originalname,
        url: `/uploads/${file.filename}`
      }))
    );

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
app.get('/api/admin/records/:id', async (req, res) => {
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
app.put('/api/admin/records/:id/status', async (req, res) => {
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

app.listen(3000, () => console.log("Server running on http://localhost:3000"));