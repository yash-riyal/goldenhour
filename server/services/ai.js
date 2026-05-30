// server/services/ai.js
// Injury-photo AI analysis service.
// Phase 1: deterministic mock that returns plausible-looking output.
// Phase 2: real Google Gemini vision call when GEMINI_API_KEY is set.
//
// All consumers call analyzeInjury({ filePath, mediaType }) -> assessment.

const fs = require('fs');
const path = require('path');

// ─── Output shape (single source of truth) ─────────────────────────
// {
//   severity:           'minor'|'moderate'|'severe'|'critical',
//   injury_type:        'laceration'|'fracture'|'burn'|'head_trauma'|'crush'|'cardiac'|'other',
//   summary:            short human sentence,
//   required_bed_type:  one of: general|icu|emergency|operation|trauma|burn|cardiac|pediatric|maternity,
//   required_capabilities: string[] (subset of capability tags used in DB),
//   blood_needed:       boolean,
//   blood_group:        e.g. 'O+' or null,
//   blood_units:        integer or null,
//   confidence:         0.0..1.0,
//   provider:           'mock' | 'gemini'
// }

// Curated severity-aware injury catalog for the mock.
// NOTE: Blood group can NOT be determined from a photo. Since the victim's
// group is unknown at the scene, blood banks dispatch ALL groups (or O-
// universal). So every blood-needed case requests 'ALL' here.
const MOCK_PROFILES = [
  {
    weight: 3,
    severity: 'severe', injury_type: 'head_trauma',
    summary: 'Suspected head trauma with visible bleeding. Patient may have lost consciousness.',
    required_bed_type: 'trauma',
    required_capabilities: ['neurosurgery', 'trauma_care', 'intensive_care'],
    blood_needed: true, blood_group: 'ALL', blood_units: 2
  },
  {
    weight: 3,
    severity: 'severe', injury_type: 'fracture',
    summary: 'Compound fracture of the lower limb. Immobilization and surgical intervention likely required.',
    required_bed_type: 'operation',
    required_capabilities: ['orthopedics', 'general_surgery'],
    blood_needed: true, blood_group: 'ALL', blood_units: 1
  },
  {
    weight: 2,
    severity: 'moderate', injury_type: 'laceration',
    summary: 'Significant laceration with moderate bleeding. Sutures and observation needed.',
    required_bed_type: 'emergency',
    required_capabilities: ['emergency_care', 'general_surgery'],
    blood_needed: false, blood_group: null, blood_units: null
  },
  {
    weight: 2,
    severity: 'critical', injury_type: 'crush',
    summary: 'Crush injury, multiple fractures suspected. High risk of internal bleeding.',
    required_bed_type: 'icu',
    required_capabilities: ['intensive_care', 'trauma_care', 'general_surgery'],
    blood_needed: true, blood_group: 'ALL', blood_units: 3
  },
  {
    weight: 1,
    severity: 'severe', injury_type: 'burn',
    summary: 'Significant burns visible across torso. Specialized burn care required.',
    required_bed_type: 'burn',
    required_capabilities: ['burns', 'intensive_care'],
    blood_needed: false, blood_group: null, blood_units: null
  },
  {
    weight: 2,
    severity: 'moderate', injury_type: 'laceration',
    summary: 'Multiple superficial lacerations. Patient appears conscious and stable.',
    required_bed_type: 'general',
    required_capabilities: ['general_surgery', 'emergency_care'],
    blood_needed: false, blood_group: null, blood_units: null
  },
  {
    weight: 1,
    severity: 'critical', injury_type: 'cardiac',
    summary: 'Patient unresponsive; suspected cardiac event. Immediate cardiac care required.',
    required_bed_type: 'cardiac',
    required_capabilities: ['cardiology', 'intensive_care'],
    blood_needed: false, blood_group: null, blood_units: null
  },
];

// Weighted random pick — keeps severe/moderate cases more common than burns/cardiac.
function pickProfile() {
  const total = MOCK_PROFILES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of MOCK_PROFILES) {
    if ((r -= p.weight) <= 0) return p;
  }
  return MOCK_PROFILES[0];
}

async function mockAnalyze(_input) {
  // Tiny artificial delay so the UI "loading…" state is visible.
  await new Promise((r) => setTimeout(r, 600));
  const p = pickProfile();
  return {
    ...p,
    confidence: 0.62 + Math.random() * 0.18,   // 0.62 – 0.80
    provider: 'mock'
  };
}

// ─── Gemini real implementation ────────────────────────────────────
// Uses gemini-2.0-flash (free tier, no credit card). Strict JSON output.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_ENDPOINT = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `You are an emergency medical triage AI for an ambulance dispatch system.
You will look at a photo of an accident or injury scene and return a structured triage assessment.

Reply with STRICT JSON only — no markdown, no commentary. The JSON MUST match this schema:
{
  "severity": "minor" | "moderate" | "severe" | "critical",
  "injury_type": "laceration" | "fracture" | "burn" | "head_trauma" | "crush" | "cardiac" | "other",
  "summary": "<one-sentence plain-English description of what you see and what the patient needs>",
  "required_bed_type": "general" | "icu" | "emergency" | "operation" | "trauma" | "burn" | "cardiac" | "pediatric" | "maternity",
  "required_capabilities": ["general_surgery" | "trauma_care" | "neurosurgery" | "orthopedics" | "cardiology" | "burns" | "pediatrics" | "obstetrics" | "intensive_care" | "emergency_care"],
  "blood_needed": true | false,
  "blood_group": "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-" | null,
  "blood_units": <integer 0-4> | null,
  "confidence": <number 0.0-1.0>
}

Rules:
- If you cannot clearly identify an injury, return severity="minor", injury_type="other", required_bed_type="general", blood_needed=false, confidence ≤ 0.4.
- Blood group CANNOT be determined from a photo. ALWAYS set blood_group to "ALL" (victim's group unknown → dispatch all groups / O- universal) when blood_needed is true, and null when false. Never guess a specific A/B/AB/O group.
- Be conservative: when in doubt, escalate severity by one level rather than under-triaging.
- For chest-clutching / collapse / unresponsive patients, use injury_type="cardiac", required_bed_type="cardiac".
- required_capabilities must be a subset of the allowed values.`;

async function geminiAnalyze({ filePath, mediaType }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const bytes = fs.readFileSync(filePath);
  const base64 = bytes.toString('base64');
  const mime = mediaType === 'video' ? 'video/mp4' : 'image/jpeg';

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mime, data: base64 } },
        { text: SYSTEM_PROMPT }
      ]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 600,
      responseMimeType: 'application/json'
    }
  };

  const res = await fetch(GEMINI_ENDPOINT(apiKey), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini returned empty response');

  // Strip code fences if model added them despite responseMimeType
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(cleaned);

  // Defensive normalization to our schema
  return {
    severity:               parsed.severity || 'moderate',
    injury_type:            parsed.injury_type || 'other',
    summary:                parsed.summary || 'AI returned no summary.',
    required_bed_type:      parsed.required_bed_type || 'emergency',
    required_capabilities:  Array.isArray(parsed.required_capabilities) ? parsed.required_capabilities : [],
    blood_needed:           !!parsed.blood_needed,
    blood_group:            parsed.blood_needed ? 'ALL' : null,   // group unknown from photo → dispatch all groups
    blood_units:            parsed.blood_needed ? (parsed.blood_units || 1) : null,
    confidence:             typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
    provider:               'gemini'
  };
}

// ─── Public entry point ────────────────────────────────────────────
async function analyzeInjury({ filePath, mediaType }) {
  // If a video, just stamp a generic assessment — Gemini will sample frames in Phase 2.
  if (mediaType === 'video') {
    return {
      ...(await mockAnalyze({ filePath, mediaType })),
      summary: 'Video evidence received; preliminary triage based on first frame.'
    };
  }

  // Confirm the file exists (sanity)
  if (filePath && !fs.existsSync(filePath)) {
    throw new Error('AI: media file not found at ' + filePath);
  }

  if (process.env.GEMINI_API_KEY) {
    try { return await geminiAnalyze({ filePath, mediaType }); }
    catch (err) {
      console.warn('[ai] gemini failed, falling back to mock:', err.message);
      return mockAnalyze({ filePath, mediaType });
    }
  }
  return mockAnalyze({ filePath, mediaType });
}

module.exports = { analyzeInjury };
