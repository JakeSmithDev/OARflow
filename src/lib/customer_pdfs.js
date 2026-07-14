// Built-in customer PDF documents. The WDII source remains an editable
// AcroForm; the service agreement is generated from scratch so no prior
// customer's data can remain hidden in the file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const WDII_TEMPLATE = path.resolve(moduleDir, '../../public/assets/pdf-templates/wdii-inspection-report.pdf');
let wdiiTemplatePromise;

export const AGREEMENT_DEFAULTS = Object.freeze({
  frequency: 'monthly',
  coveredPests: 'Rodents, Roaches and General Pest',
  initialServiceFeeCents: 0,
  serviceFeeCents: 10_000,
});

const AGREEMENT_TERMS = [
  'The company agrees to perform pest control services at the service address listed above.',
  'The company will provide {FREQUENCY} pest control services to control the indicated pest(s).',
  'Customer agrees to make the place of service available for treatment and/or inspection as often as necessary to control the pests noted below.',
  'This agreement will be for an initial term of 12 months.',
  'After the initial period, this agreement will automatically renew for the same term unless canceled by either party by giving a 30-day notice in writing to the other party.',
  'If for any reason the customer is unable to fulfill the term obligation, the customer agrees to pay an early termination fee equal to 50% of the remaining contract value ($75.00 minimum).',
  'The company reserves the right to revise the service charge after the first year of service.',
  'This agreement does not provide for the repair of present or future damages to the service address, nor does it provide for reimbursement for repair expenses allegedly arising from pest infestations.',
  'In entering into this agreement, the customer waives all claims for damages to property or persons which may result indirectly from work performed by the company, with the exception of gross negligence on the part of the company.',
  'This agreement does not include service for termites or other wood destroying insects, nor does it provide for damages arising from infestation of the same.',
];

const SCHEDULING_TEXT = 'I understand that I will have a regular appointment window set for me each service frequency. If this date is inconvenient or I cannot make the appointment, I will contact the company with at least 24-hour prior notice or I will be responsible for payment of the service. If I am not present for the scheduled service, the company may treat the exterior, leave notice of service, and I will be responsible for payment of the exterior service. It is my responsibility to schedule another treatment during the service-frequency period; otherwise I remain responsible for payment whether or not the service was completed.';

function clean(value, max = 1_000) {
  return String(value ?? '').trim().slice(0, max);
}

// pdf-lib's built-in Helvetica uses WinAnsi. Normalize user-entered text so an
// emoji or smart punctuation cannot make an otherwise valid document fail.
function pdfSafe(value) {
  return clean(value, 4_000)
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function regionLine(customer) {
  return [clean(customer?.city, 120), [clean(customer?.state, 30), clean(customer?.postal_code ?? customer?.postalCode, 30)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

export function serviceAddress(customer) {
  return [clean(customer?.address, 240), regionLine(customer)].filter(Boolean).join(', ');
}

export function businessLicenseNumber(tenant) {
  const configured = tenant?.settings?.documents?.businessLicenseNumber
    || tenant?.settings?.compliance?.businessLicenseNumber
    || tenant?.settings?.compliance?.licenseNumber;
  return clean(configured || '33560', 40).replace(/^MDA\s*#?\s*/i, '') || '33560';
}

export function shortDateInTimeZone(date = new Date(), timeZone = 'America/New_York') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: '2-digit', month: 'numeric', day: 'numeric',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.month}/${parts.day}/${parts.year}`;
}

export function safePdfFilename(customerName, suffix) {
  const base = clean(customerName, 80).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Customer';
  return `${base}_${suffix}.pdf`;
}

async function wdiiBytes() {
  if (!wdiiTemplatePromise) wdiiTemplatePromise = fs.readFile(WDII_TEMPLATE);
  return wdiiTemplatePromise;
}

export async function generateWdiiInspectionPdf(tenant, customer, { date = new Date() } = {}) {
  const pdf = await PDFDocument.load(await wdiiBytes());
  const form = pdf.getForm();
  const fullAddress = serviceAddress(customer);
  const inspected = [clean(customer?.name, 160), fullAddress].filter(Boolean).join('\n');
  form.getTextField('lic_no').setText(businessLicenseNumber(tenant));
  form.getTextField('date_inspection').setText(shortDateInTimeZone(date, tenant?.timezone));
  form.getTextField('address_inspected').setText(pdfSafe(inspected));
  form.getTextField('seller_print_name').setText(pdfSafe(customer?.name));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  form.updateFieldAppearances(font);
  pdf.setTitle(`WDII Inspection Report - ${pdfSafe(customer?.name)}`);
  pdf.setAuthor(tenant?.settings?.branding?.logoText || tenant?.name || 'OARFlow');
  pdf.setSubject('Wood Destroying Insect Inspection Report');
  pdf.setModificationDate(new Date());
  return Buffer.from(await pdf.save());
}

function hexColor(value, fallback = rgb(0.055, 0.49, 0.294)) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value || ''));
  if (!match) return fallback;
  return rgb(parseInt(match[1].slice(0, 2), 16) / 255, parseInt(match[1].slice(2, 4), 16) / 255, parseInt(match[1].slice(4, 6), 16) / 255);
}

function wrapLines(text, font, size, maxWidth) {
  const paragraphs = pdfSafe(text).split(/\r?\n/);
  const rows = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { rows.push(''); continue; }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
      else { rows.push(line); line = word; }
    }
    if (line) rows.push(line);
  }
  return rows;
}

function ellipsize(line, font, size, maxWidth) {
  let out = line;
  while (out && font.widthOfTextAtSize(`${out}...`, size) > maxWidth) out = out.slice(0, -1).trimEnd();
  return `${out}...`;
}

function fitText(text, font, maxWidth, startSize = 8, minimum = 5.5) {
  let size = startSize;
  const value = pdfSafe(text);
  while (size > minimum && font.widthOfTextAtSize(value, size) > maxWidth) size -= 0.25;
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return { text: value, size };
  return { text: ellipsize(value, font, size, maxWidth), size };
}

function drawWrapped(page, text, { x, y, width, font, size = 7, lineHeight = size * 1.25, color, maxLines } = {}) {
  let lines = wrapLines(text, font, size, width);
  if (maxLines && lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = ellipsize(lines[maxLines - 1], font, size, width);
  }
  lines.forEach((line, index) => page.drawText(line, { x, y: y - index * lineHeight, size, font, color }));
  return y - lines.length * lineHeight;
}

function drawInfoBox(page, { x, y, width, height, title, rows, regular, bold, ink, muted, line }) {
  page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1), borderColor: line, borderWidth: 0.8 });
  page.drawRectangle({ x, y: y + height - 24, width, height: 24, color: rgb(0.965, 0.976, 0.972) });
  const heading = fitText(title.toUpperCase(), bold, width - 20, 8, 6.5);
  page.drawText(heading.text, { x: x + 10, y: y + height - 16, size: heading.size, font: bold, color: ink });
  const usable = height - 31;
  const rowHeight = usable / rows.length;
  rows.forEach(([label, value], index) => {
    const baseline = y + height - 34 - index * rowHeight;
    const labelWidth = Math.min(width * 0.42, regular.widthOfTextAtSize(`${label}:`, 6.2) + 5);
    page.drawText(`${label}:`, { x: x + 10, y: baseline, size: 6.2, font: bold, color: muted });
    const fitted = fitText(value || '-', regular, width - labelWidth - 22, 7.2, 5.4);
    page.drawText(fitted.text, { x: x + 10 + labelWidth, y: baseline, size: fitted.size, font: regular, color: ink });
    page.drawLine({ start: { x: x + 10 + labelWidth, y: baseline - 2 }, end: { x: x + width - 10, y: baseline - 2 }, thickness: 0.45, color: line });
  });
}

function money(cents) {
  const value = Math.max(0, Math.round(Number(cents) || 0)) / 100;
  return value % 1 === 0 ? `$${value.toLocaleString('en-US')}` : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function generateServiceAgreementPdf(tenant, customer, options = {}) {
  const frequency = options.frequency === 'quarterly' ? 'quarterly' : 'monthly';
  const frequencyLabel = frequency === 'quarterly' ? 'Quarterly' : 'Monthly';
  const initialServiceFeeCents = Math.max(0, Math.round(Number(options.initialServiceFeeCents ?? AGREEMENT_DEFAULTS.initialServiceFeeCents) || 0));
  const serviceFeeCents = Math.max(0, Math.round(Number(options.serviceFeeCents ?? AGREEMENT_DEFAULTS.serviceFeeCents) || 0));
  const visits = frequency === 'quarterly' ? 4 : 12;
  const totalTermCostCents = initialServiceFeeCents + serviceFeeCents * visits;
  const notes = clean(options.notes, 500) || 'No additional comments.';
  const coveredPests = clean(options.coveredPests, 300) || AGREEMENT_DEFAULTS.coveredPests;

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.105, 0.15);
  const muted = rgb(0.34, 0.4, 0.47);
  const line = rgb(0.78, 0.82, 0.86);
  const accent = hexColor(tenant?.settings?.branding?.primaryColor);
  const companyName = pdfSafe(tenant?.settings?.branding?.logoText || tenant?.name || 'Pasternack Pest Management LLC');
  const customerName = pdfSafe(customer?.name);
  const address = pdfSafe(customer?.address);
  const region = pdfSafe(regionLine(customer));

  const headerCompany = fitText(companyName.toUpperCase(), bold, 390, 9.5, 7);
  page.drawText(headerCompany.text, { x: 38, y: 758, size: headerCompany.size, font: bold, color: ink });
  page.drawText(`MDA#${businessLicenseNumber(tenant)}`, { x: 504, y: 758, size: 8.5, font: bold, color: ink });
  page.drawLine({ start: { x: 38, y: 746 }, end: { x: 574, y: 746 }, thickness: 2, color: accent });
  const title = 'Pest Control Service Agreement';
  page.drawText(title, { x: (612 - bold.widthOfTextAtSize(title, 18)) / 2, y: 718, size: 18, font: bold, color: ink });

  drawInfoBox(page, {
    x: 38, y: 574, width: 258, height: 116, title: 'Customer information', regular, bold, ink, muted, line,
    rows: [['Name', customerName], ['Address', address], ['City', region], ['Phone', pdfSafe(customer?.phone)], ['Email', pdfSafe(customer?.email)]],
  });
  drawInfoBox(page, {
    x: 308, y: 574, width: 266, height: 116, title: 'Servicing address', regular, bold, ink, muted, line,
    rows: [['Name', customerName], ['Address', address], ['City / State / ZIP', region]],
  });

  const termsHeading = 'TERMS AND CONDITIONS';
  page.drawText(termsHeading, { x: (612 - bold.widthOfTextAtSize(termsHeading, 8.5)) / 2, y: 555, size: 8.5, font: bold, color: ink });
  let y = 542;
  AGREEMENT_TERMS.forEach((term, index) => {
    const content = `${index + 1}) ${term.replace('{FREQUENCY}', `${frequencyLabel} (frequency)`)}`;
    const lines = wrapLines(content, regular, 6.25, 536);
    lines.forEach((text, lineIndex) => page.drawText(text, { x: 38, y: y - lineIndex * 7.25, size: 6.25, font: regular, color: ink }));
    y -= lines.length * 7.25 + 1.2;
  });

  y -= 3;
  page.drawText('SCHEDULING', { x: 38, y, size: 6.5, font: bold, color: ink });
  y -= 9;
  y = drawWrapped(page, SCHEDULING_TEXT, { x: 38, y, width: 536, font: regular, size: 6.1, lineHeight: 7.25, color: ink, maxLines: 6 });

  const detailTop = Math.min(y - 5, 338);
  const detailHeight = 116;
  const detailBottom = detailTop - detailHeight;
  page.drawRectangle({ x: 38, y: detailBottom, width: 536, height: detailHeight, color: rgb(0.975, 0.981, 0.979), borderColor: line, borderWidth: 0.8 });
  page.drawRectangle({ x: 38, y: detailTop - 24, width: 536, height: 24, color: rgb(0.91, 0.96, 0.93) });
  page.drawText('SERVICE DETAILS', { x: 49, y: detailTop - 16, size: 8, font: bold, color: accent });
  page.drawText('Initially covered pests:', { x: 49, y: detailTop - 39, size: 6.6, font: bold, color: muted });
  const pestsFit = fitText(coveredPests, regular, 222, 7.2, 5.8);
  page.drawText(pestsFit.text, { x: 139, y: detailTop - 39, size: pestsFit.size, font: regular, color: ink });
  page.drawText('Frequency:', { x: 389, y: detailTop - 39, size: 6.6, font: bold, color: muted });
  page.drawText(frequencyLabel, { x: 439, y: detailTop - 39, size: 7.2, font: bold, color: accent });
  page.drawText('Initial service fee:', { x: 49, y: detailTop - 57, size: 6.6, font: bold, color: muted });
  page.drawText(money(initialServiceFeeCents), { x: 126, y: detailTop - 57, size: 7.2, font: bold, color: ink });
  page.drawText('Cost per service:', { x: 211, y: detailTop - 57, size: 6.6, font: bold, color: muted });
  page.drawText(money(serviceFeeCents), { x: 282, y: detailTop - 57, size: 7.2, font: bold, color: ink });
  page.drawText('12-month total:', { x: 389, y: detailTop - 57, size: 6.6, font: bold, color: muted });
  page.drawText(money(totalTermCostCents), { x: 459, y: detailTop - 57, size: 7.2, font: bold, color: ink });
  page.drawLine({ start: { x: 49, y: detailTop - 65 }, end: { x: 563, y: detailTop - 65 }, thickness: 0.45, color: line });
  page.drawText('Additional comments / service notes', { x: 49, y: detailTop - 79, size: 6.6, font: bold, color: muted });
  drawWrapped(page, notes, { x: 49, y: detailTop - 91, width: 514, font: regular, size: 6.3, lineHeight: 7.2, color: ink, maxLines: 3 });

  const signatureY = detailBottom - 35;
  page.drawText('COMPANY SIGNATURE', { x: 38, y: signatureY, size: 6.7, font: bold, color: muted });
  page.drawLine({ start: { x: 130, y: signatureY - 1 }, end: { x: 292, y: signatureY - 1 }, thickness: 0.7, color: ink });
  page.drawText('CUSTOMER SIGNATURE', { x: 320, y: signatureY, size: 6.7, font: bold, color: muted });
  page.drawLine({ start: { x: 418, y: signatureY - 1 }, end: { x: 574, y: signatureY - 1 }, thickness: 0.7, color: ink });

  const footerY = signatureY - 38;
  page.drawText('Agreement date', { x: 38, y: footerY, size: 6.7, font: bold, color: muted });
  page.drawText(shortDateInTimeZone(options.date || new Date(), tenant?.timezone), { x: 108, y: footerY, size: 7.2, font: regular, color: ink });
  page.drawLine({ start: { x: 105, y: footerY - 2 }, end: { x: 180, y: footerY - 2 }, thickness: 0.5, color: line });
  page.drawText('Maryland Poison Control: 1-800-222-1222', { x: 374, y: footerY, size: 6.7, font: regular, color: muted });
  page.drawText('Customer and company signatures acknowledge the terms above.', { x: 38, y: 46, size: 5.8, font: regular, color: muted });
  page.drawText('Page 1 of 1', { x: 532, y: 46, size: 5.8, font: regular, color: muted });

  pdf.setTitle(`Pest Control Service Agreement - ${customerName}`);
  pdf.setAuthor(companyName);
  pdf.setSubject(`${frequencyLabel} pest control service agreement`);
  pdf.setKeywords(['pest control', 'service agreement', frequency]);
  pdf.setCreationDate(new Date());
  return Buffer.from(await pdf.save());
}

export default {
  AGREEMENT_DEFAULTS, serviceAddress, businessLicenseNumber, shortDateInTimeZone,
  safePdfFilename, generateWdiiInspectionPdf, generateServiceAgreementPdf,
};
