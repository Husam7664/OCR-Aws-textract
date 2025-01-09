const { TextractClient, AnalyzeDocumentCommand } = require("@aws-sdk/client-textract");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { fromIni } = require("@aws-sdk/credential-provider-ini");
const PDFDocument = require("pdfkit");
const sharp = require("sharp");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { PDFDocument: PdfLibDocument } = require("pdf-lib");
const { createCanvas } = require("canvas");
const pdfjsLib = require("pdfjs-dist");

async function processPdf(config) {
  const {
    region = "us-west-2",
    bucket,
    inputKey,
    outputDir = "./ocr-output",
    profile = "default",
  } = config;

  const credentials = fromIni({ profile });
  const textractClient = new TextractClient({ region, credentials });
  const s3Client = new S3Client({ region, credentials });

  async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function renderPageAsImage(pdfBuffer, pageIndex) {
    const pdfDocument = await pdfjsLib.getDocument({ data: pdfBuffer }).promise;
    const page = await pdfDocument.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext("2d");

    await page.render({
      canvasContext: context,
      viewport: viewport,
    }).promise;

    return canvas.toBuffer("image/png");
  }

  // Helper function to organize blocks into lines and paragraphs
  function organizeBlocks(blocks) {
    // First, separate words and lines
    const words = blocks.filter(block => block.BlockType === "WORD");
    const lines = blocks.filter(block => block.BlockType === "LINE");
    
    // Sort words by vertical position, then horizontal
    const sortedWords = words.sort((a, b) => {
      const yDiff = a.Geometry.BoundingBox.Top - b.Geometry.BoundingBox.Top;
      if (Math.abs(yDiff) < 0.01) { // If on same line (within threshold)
        return a.Geometry.BoundingBox.Left - b.Geometry.BoundingBox.Left;
      }
      return yDiff;
    });

    // Group words into lines based on vertical position
    const groupedLines = [];
    let currentLine = [];
    let currentY = null;

    sortedWords.forEach(word => {
      const wordY = word.Geometry.BoundingBox.Top;
      
      if (currentY === null) {
        currentY = wordY;
        currentLine.push(word);
      } else if (Math.abs(wordY - currentY) < 0.01) { // Words on same line
        currentLine.push(word);
      } else {
        if (currentLine.length > 0) {
          groupedLines.push(currentLine);
        }
        currentLine = [word];
        currentY = wordY;
      }
    });

    if (currentLine.length > 0) {
      groupedLines.push(currentLine);
    }

    // Convert grouped words into text lines
    return groupedLines.map(lineWords => ({
      Text: lineWords.map(word => word.Text).join(" "),
      Confidence: Math.min(...lineWords.map(word => word.Confidence)),
      Geometry: {
        BoundingBox: {
          Top: lineWords[0].Geometry.BoundingBox.Top,
          Left: lineWords[0].Geometry.BoundingBox.Left,
          Height: lineWords[0].Geometry.BoundingBox.Height,
          Width: Math.max(...lineWords.map(word => 
            word.Geometry.BoundingBox.Left + word.Geometry.BoundingBox.Width
          )) - lineWords[0].Geometry.BoundingBox.Left
        }
      }
    }));
  }

  async function analyzeDocument(buffer) {
    const textractParams = {
      Document: { Bytes: buffer },
      FeatureTypes: ["TABLES", "FORMS"],
    };

    try {
      const analyzeCommand = new AnalyzeDocumentCommand(textractParams);
      return await textractClient.send(analyzeCommand);
    } catch (error) {
      console.error("Error analyzing document with Textract:", error);
      throw error;
    }
  }

  async function processPages(pdfBuffer) {
    const pdfDoc = await PdfLibDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();
    console.log(`Processing ${pageCount} page(s)`);

    const imageBuffers = [];
    const processedTextMap = new Map();

    for (let i = 0; i < pageCount; i++) {
      console.log(`Processing page ${i + 1}...`);
      const imageBuffer = await renderPageAsImage(pdfBuffer, i);
      imageBuffers.push(imageBuffer);

      const textractResponse = await analyzeDocument(imageBuffer);
      const organizedText = organizeBlocks(textractResponse.Blocks);
      processedTextMap.set(i, organizedText);
    }

    return { imageBuffers, processedTextMap };
  }

  async function generatePDF(imageBuffers, processedTextMap) {
    await fs.mkdir(outputDir, { recursive: true });
    const inputBasename = path.basename(inputKey, path.extname(inputKey));
    const pdfOutputPath = path.join(outputDir, `${inputBasename}_ocr.pdf`);

    const doc = new PDFDocument({ margin: 20 });
    const writeStream = fsSync.createWriteStream(pdfOutputPath);
    doc.pipe(writeStream);

    for (let i = 0; i < imageBuffers.length; i++) {
      const imageBuffer = imageBuffers[i];
      const processedText = processedTextMap.get(i);

      const dimensions = await sharp(imageBuffer).metadata();
      const { width, height } = dimensions;
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const scaleFactor = Math.min(pageWidth / width, pageHeight / height);
      const scaledWidth = width * scaleFactor;
      const scaledHeight = height * scaleFactor;

      // Add original image
      doc.image(imageBuffer, 0, 0, { width: scaledWidth, height: scaledHeight });

      // Add processed text on new page
      if (processedText && processedText.length > 0) {
        doc.addPage();
        doc.font("Helvetica");
        let currentY = 20;

        processedText.forEach(line => {
          const fontSize = Math.max(line.Geometry.BoundingBox.Height * pageHeight * 0.8, 12);
          const lineHeight = fontSize * 1.2;

          if (currentY + lineHeight > pageHeight - 20) {
            doc.addPage();
            currentY = 20;
          }

          doc.fontSize(fontSize)
             .fillColor(line.Confidence < 90 ? "#666666" : "#000000")
             .text(line.Text, 20, currentY, {
               width: pageWidth - 40,
               align: "left"
             });

          currentY += lineHeight;
        });
      }

      if (i < imageBuffers.length - 1) {
        doc.addPage();
      }
    }

    doc.end();

    return new Promise((resolve, reject) => {
      writeStream.on("finish", () => {
        console.log(`PDF saved to: ${pdfOutputPath}`);
        resolve(pdfOutputPath);
      });
      writeStream.on("error", reject);
    });
  }

  try {
    console.log("Downloading file from S3...");
    const getObjectCommand = new GetObjectCommand({ Bucket: bucket, Key: inputKey });
    const response = await s3Client.send(getObjectCommand);
    const buffer = await streamToBuffer(response.Body);

    if (inputKey.toLowerCase().endsWith(".pdf")) {
      console.log("Processing PDF...");
      const { imageBuffers, processedTextMap } = await processPages(buffer);
      console.log("Generating OCR PDF...");
      const pdfPath = await generatePDF(imageBuffers, processedTextMap);
      return { success: true, message: "Document processed successfully", pdfPath };
    } else {
      console.log("Processing single image...");
      const textractResponse = await analyzeDocument(buffer);
      const processedText = organizeBlocks(textractResponse.Blocks);
      const processedTextMap = new Map([[0, processedText]]);
      const pdfPath = await generatePDF([buffer], processedTextMap);
      return { success: true, message: "Document processed successfully", pdfPath };
    }
  } catch (error) {
    console.error("Error in document processing:", error);
    return { success: false, message: error.message };
  }
}

async function main() {
  const config = {
    region: "us-west-2",
    bucket: "workhub24-test-export",
    inputKey: "test/files/non-text-searchable.pdf",
    outputDir: "./ocr-output",
    profile: "default",
  };

  try {
    const result = await processPdf(config);
    console.log("Processing result:", result);
  } catch (error) {
    console.error("Error in main:", error);
  }
}

if (require.main === module) {
  main();
}

module.exports = { processPdf };