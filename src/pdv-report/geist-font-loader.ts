import type { jsPDF } from 'jspdf';
import geistFonts from './geist-fonts-base64.json';

/**
 * Adds Geist font (Regular and Bold) to a jsPDF instance
 */
export function addGeistFont(doc: jsPDF) {
  // Add Geist Regular
  doc.addFileToVFS('Geist-Regular.ttf', geistFonts.regular);
  doc.addFont('Geist-Regular.ttf', 'Geist', 'normal');

  // Add Geist Bold
  doc.addFileToVFS('Geist-Bold.ttf', geistFonts.bold);
  doc.addFont('Geist-Bold.ttf', 'Geist', 'bold');
}
