// migrate-artifacts.js — pull from in-memory store, insert into SQLite
const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3100' + urlPath, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    }).on('error', reject);
  });
}

async function main() {
  // 1. Fetch all artifacts with content
  const listRes = await get('/ui/api/artifacts');
  const artifacts = listRes.artifacts;
  
  for (const a of artifacts) {
    const content = await get('/ui/api/artifacts/' + a.id);
    a.content = typeof content === 'string' ? content : JSON.stringify(content);
    a.size_bytes = Buffer.byteLength(a.content, 'utf-8');
  }
  
  // 2. Open SQLite database
  const dbPath = path.join(__dirname, '..', 'data', 'artifacts.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  // 3. Execute schema
  const schema = fs.readFileSync(path.join(__dirname, '..', 'data', 'schema.sql'), 'utf-8');
  db.exec(schema);
  
  // 4. Insert reference data
  const catId = 'cat-econ-001';
  const sub1Id = 'sub-m3-inventory';
  const sub2Id = 'sub-m3-shipments';
  const modelId = 'deepseek/deepseek-v4-pro';
  const sess1Id = 'sess-2026-05-25-a'; // inventory session
  const sess2Id = 'sess-2026-05-25-b'; // shipments session
  
  db.prepare(`INSERT OR IGNORE INTO category (id, name, description, created_at) VALUES (?, ?, ?, ?)`)
    .run(catId, 'Economics', 'Economic data from BLS, Census Bureau, and Federal Reserve', '2026-05-25T00:00:00.000Z');
  
  db.prepare(`INSERT OR IGNORE INTO subject (id, category_id, name, description, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sub1Id, catId, 'M3 Series Inventory', 'Discovery inventory of all M3 manufacturing series, codes, and sources from data/lookups/m3_series.json', '["m3","inventory","lookup","manufacturing"]', '2026-05-25T08:00:00.000Z');
  
  db.prepare(`INSERT OR IGNORE INTO subject (id, category_id, name, description, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sub2Id, catId, 'M3 Manufacturing Shipments', 'NSA total manufacturing shipments analysis — Census M3 MTM/VS, Jan 2002–Mar 2026', '["m3","shipments","nsa","manufacturing","d3"]', '2026-05-25T21:40:00.000Z');
  
  db.prepare(`INSERT OR IGNORE INTO model (id, provider, display_name, created_at) VALUES (?, ?, ?, ?)`)
    .run(modelId, 'openrouter', 'DeepSeek V4 Pro', '2026-05-25T00:00:00.000Z');
  
  // 5. Insert sessions (logical split: one per subject)
  db.prepare(`INSERT OR IGNORE INTO session (id, subject_id, model_id, title, started_at, ended_at, prompt_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sess1Id, sub1Id, modelId, 'M3 Series Discovery', '2026-05-25T08:00:00.000Z', '2026-05-25T08:38:03.000Z', 1, '2026-05-25T08:00:00.000Z');
  
  db.prepare(`INSERT OR IGNORE INTO session (id, subject_id, model_id, title, started_at, ended_at, prompt_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sess2Id, sub2Id, modelId, 'M3 Shipments NSA Chart', '2026-05-25T21:46:00.000Z', '2026-05-25T22:08:42.000Z', 3, '2026-05-25T21:46:00.000Z');
  
  // 6. Insert artifacts
  const provenance = JSON.stringify({
    sources: ['Census M3 EITS API'],
    lookups: ['data/lookups/m3_series.json'],
    tools: ['create_artifact', 'create_chart_svg'],
    skills: [],
    data_files: ['data/m3_total_mfg_shipments_nsa.csv']
  });
  
  const insertArtifact = db.prepare(`
    INSERT OR IGNORE INTO artifact
      (id, session_id, title, filename, mime_type, role, description, content, size_bytes,
       created_at, updated_at, model_id, replaces_id, provenance, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  // Transaction for all artifacts
  const insertAll = db.transaction(() => {
    // --- M3 Inventory session ---
    // mpkx6h4d = markdown (v1, original)
    const inv = artifacts.find(a => a.id === 'mpkx6h4d-bc55173f');
    if (inv) {
      insertArtifact.run(
        inv.id, sess1Id, inv.title, inv.filename, inv.mimeType, inv.role,
        inv.description, inv.content, inv.size_bytes,
        inv.createdAt, inv.updatedAt, modelId, null,
        JSON.stringify({sources:['data/lookups/m3_series.json'],lookups:['m3_series.json'],tools:['create_artifact'],skills:[],data_files:[]}),
        '["m3","inventory","lookup","markdown"]'
      );
    }
    
    // mpkyenq3 = HTML (v2, replaces markdown)
    const invHtml = artifacts.find(a => a.id === 'mpkyenq3-09245adb');
    if (invHtml) {
      insertArtifact.run(
        invHtml.id, sess1Id, invHtml.title, invHtml.filename, invHtml.mimeType, invHtml.role,
        invHtml.description, invHtml.content, invHtml.size_bytes,
        invHtml.createdAt, invHtml.updatedAt, modelId, 'mpkx6h4d-bc55173f',
        JSON.stringify({sources:['data/lookups/m3_series.json'],lookups:['m3_series.json'],tools:['create_artifact'],skills:[],data_files:[]}),
        '["m3","inventory","lookup","html"]'
      );
    }
    
    // --- M3 Shipments session ---
    // mplqk55m = chart v1 (broken - references external CSV)
    const ch1 = artifacts.find(a => a.id === 'mplqk55m-f1b43073');
    if (ch1) {
      insertArtifact.run(
        ch1.id, sess2Id, ch1.title, ch1.filename, ch1.mimeType, ch1.role,
        ch1.description, ch1.content, ch1.size_bytes,
        ch1.createdAt, ch1.updatedAt, modelId, null,
        provenance,
        '["m3","shipments","nsa","chart","d3","v1"]'
      );
    }
    
    // mplqnj21 = chart v2 (embedded data, invisible text)
    const ch2 = artifacts.find(a => a.id === 'mplqnj21-1342968e');
    if (ch2) {
      insertArtifact.run(
        ch2.id, sess2Id, ch2.title, ch2.filename, ch2.mimeType, ch2.role,
        ch2.description, ch2.content, ch2.size_bytes,
        ch2.createdAt, ch2.updatedAt, modelId, 'mplqk55m-f1b43073',
        provenance,
        '["m3","shipments","nsa","chart","d3","v2"]'
      );
    }
    
    // mplqpqc0 = CSV (standalone, not a chart version)
    const csv = artifacts.find(a => a.id === 'mplqpqc0-d1da89de');
    if (csv) {
      insertArtifact.run(
        csv.id, sess2Id, csv.title, csv.filename, csv.mimeType, csv.role,
        csv.description, csv.content, csv.size_bytes,
        csv.createdAt, csv.updatedAt, modelId, null,
        provenance,
        '["m3","shipments","nsa","csv"]'
      );
    }
    
    // mplrd581 = chart v3 (latest, good)
    const ch3 = artifacts.find(a => a.id === 'mplrd581-19c9887b');
    if (ch3) {
      insertArtifact.run(
        ch3.id, sess2Id, ch3.title, ch3.filename, ch3.mimeType, ch3.role,
        ch3.description, ch3.content, ch3.size_bytes,
        ch3.createdAt, ch3.updatedAt, modelId, 'mplqnj21-1342968e',
        provenance,
        '["m3","shipments","nsa","chart","d3","v3"]'
      );
    }
  });
  
  insertAll();
  
  // 7. Verification queries
  console.log('=== Category ===');
  console.table(db.prepare('SELECT * FROM category').all());
  
  console.log('\n=== Subjects ===');
  console.table(db.prepare('SELECT id, category_id, name FROM subject').all());
  
  console.log('\n=== Sessions ===');
  console.table(db.prepare('SELECT id, subject_id, title, prompt_count FROM session').all());
  
  console.log('\n=== Artifacts (all, with version chain) ===');
  console.table(db.prepare('SELECT id, session_id, role, mime_type, replaces_id as supersedes, substr(title,1,45) as title FROM artifact ORDER BY created_at').all());
  
  console.log('\n=== artifact_latest view ===');
  console.table(db.prepare('SELECT id, role, mime_type, substr(title,1,45) as title FROM artifact_latest ORDER BY created_at').all());
  
  console.log('\n=== catalog view ===');
  console.table(db.prepare('SELECT category, subject, artifact_title, role, model FROM catalog ORDER BY artifact_created').all());
  
  // 8. Counts
  const totalArtifacts = db.prepare('SELECT COUNT(*) as c FROM artifact').get().c;
  const latestArtifacts = db.prepare('SELECT COUNT(*) as c FROM artifact_latest').get().c;
  const superseded = totalArtifacts - latestArtifacts;
  
  console.log(`\n=== Summary ===`);
  console.log(`Total artifacts: ${totalArtifacts} (${latestArtifacts} latest, ${superseded} superseded)`);
  console.log(`Categories: ${db.prepare('SELECT COUNT(*) as c FROM category').get().c}`);
  console.log(`Subjects:   ${db.prepare('SELECT COUNT(*) as c FROM subject').get().c}`);
  console.log(`Sessions:   ${db.prepare('SELECT COUNT(*) as c FROM session').get().c}`);
  console.log(`Models:     ${db.prepare('SELECT COUNT(*) as c FROM model').get().c}`);
  console.log(`\nDatabase: ${dbPath}`);
  
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });