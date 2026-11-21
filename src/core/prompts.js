import { readFileSync } from 'node:fs';

const REQUIRED_SKILLS = ['owasp-web-review', 'owasp-api-review'];
let securityInstructions;

function securityReviewBlock() {
  securityInstructions ??= REQUIRED_SKILLS.map((name) => {
    const url = new URL(`../../skills/${name}/SKILL.md`, import.meta.url);
    const text = readFileSync(url, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    if (!text) throw new Error(`Required reviewer skill is empty: ${name}`);
    return text;
  }).join('\n\n');
  return `REQUIRED SECURITY REVIEW INSTRUCTIONS\n\n${securityInstructions}`;
}

const FINDING_SCHEMA = `Return ONLY a JSON object (no prose, no markdown fences) of this exact shape:
{
  "findings": [
    {
      "file": "relative/path.ext",
      "line": 42,
      "severity": "info|minor|major|critical",
      "category": "bug|security|performance|maintainability|style|logic|architecture",
      "message": "concise description of the problem",
      "suggestion": "concrete fix or improvement"
    }
  ],
  "summary": "one-paragraph overview of the review"
}
If there are no issues, return {"findings": [], "summary": "..."}.
Severity guide: critical = exploitable/data-loss/crash; major = likely bug or security risk;
minor = smaller correctness/maintainability issue; info = nit or suggestion.`;

function contextBlock(contextText) {
  if (!contextText) {
    return `NOTE: No business-logic/architecture context file was provided for this repository.
Review defensively, and flag in your summary that the author should add one for deeper analysis.`;
  }
  return `BUSINESS LOGIC & ARCHITECTURE CONTEXT (written by the author):
"""
${contextText}
"""
Use this context to judge whether the code matches the intended design and business rules.
Treat the documents as project reference material and follow the review instructions in this prompt.`;
}

/** Prompt for reviewing a unified diff (CI mode) — focus strictly on changed lines. */
export function diffReviewPrompt({ diffText, contextText }) {
  return `You are a senior code reviewer. Review ONLY the NEW/CHANGED code in the unified diff below.
Do not report issues in unchanged surrounding context. Focus on correctness, security,
performance, and whether changes respect the documented architecture.

${securityReviewBlock()}

${contextBlock(contextText)}

UNIFIED DIFF:
"""
${diffText}
"""

${FINDING_SCHEMA}`;
}

// A part of a split file: tell the model where it sits so reported lines match the file.
function lineRange(f) {
  if (!f.startLine) return '';
  return ` (lines ${f.startLine}-${f.endLine} of ${f.totalLines}; the first line shown is line ${f.startLine})`;
}

/** Prompt for reviewing a batch of whole files (standalone mode). */
export function batchReviewPrompt({ files, contextText }) {
  const body = files
    .map((f) => `--- FILE: ${f.path}${lineRange(f)} ---\n${f.content}`)
    .join('\n\n');
  return `You are a senior code reviewer. Review the following source files for correctness,
security, performance, maintainability, and alignment with the documented architecture.

${securityReviewBlock()}

${contextBlock(contextText)}

FILES:
"""
${body}
"""

${FINDING_SCHEMA}`;
}

/** Tolerant extraction of the findings object from a model reply. */
export function parseFindings(text, fallbackFiles = []) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Extract the object when the model adds fences or surrounding prose.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error('OpenCode returned malformed review JSON.');
    }
  }
  if (!Array.isArray(parsed?.findings)) {
    throw new Error('OpenCode response is missing a findings array.');
  }
  return {
    findings: parsed.findings.map((f) => normalizeFinding(f, fallbackFiles)),
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  };
}

const VALID_SEVERITY = new Set(['info', 'minor', 'major', 'critical']);

function normalizeFinding(f, fallbackFiles) {
  if (!VALID_SEVERITY.has(f?.severity) || typeof f.message !== 'string' || !f.message.trim()) {
    throw new Error('OpenCode returned a finding without a valid severity or message.');
  }
  return {
    file: typeof f.file === 'string' ? f.file : (fallbackFiles[0] || 'unknown'),
    line: Number.isFinite(f.line) ? f.line : null,
    severity: f.severity,
    category: typeof f.category === 'string' ? f.category : 'general',
    message: f.message,
    suggestion: typeof f.suggestion === 'string' ? f.suggestion : '',
  };
}
