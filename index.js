const { TextractClient, AnalyzeDocumentCommand } = require("@aws-sdk/client-textract");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { fromIni } = require("@aws-sdk/credential-provider-ini");
const PDFDocument = require("pdfkit");
const sharp = require("sharp");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { PDFDocument: PdfLibDocument } = require("pdf-lib");
const { createCanvas } = require("canvas"); // Import canvas for rendering PDFs
const pdfjsLib = require("pdfjs-dist"); // Make sure this is included

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
    const page = await pdfDocument.getPage(pageIndex + 1); // Pages are 1-indexed in PDF.js
  
    const viewport = page.getViewport({ scale: 2 }); // Adjust scale as needed
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext("2d");

    const renderContext = {
      canvasContext: context,
      viewport: viewport,
    };

    await page.render(renderContext).promise;

    // Convert canvas to a PNG buffer
    const pngBuffer = canvas.toBuffer("image/png");
    return pngBuffer;
  }

  async function extractImagesFromPDF(pdfBuffer) {
    const pdfDoc = await PdfLibDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();
    const imageBuffers = [];
  
    console.log(`Extracting content from ${pageCount} page(s).`);
  
    for (let i = 0; i < pageCount; i++) {
      console.log(`Processing page ${i + 1}...`);
      const renderedImageBuffer = await renderPageAsImage(pdfBuffer, i);
      imageBuffers.push(renderedImageBuffer);
    }
  
    return imageBuffers;
  }

  async function analyzeDocument(buffer) {
    const textractParams = {
      Document: { Bytes: buffer },
      FeatureTypes: ["TABLES", "FORMS"],
    };

    try {
      const analyzeCommand = new AnalyzeDocumentCommand(textractParams);
      console.log("Analyzing document with Textract...");
      return await textractClient.send(analyzeCommand);
    } catch (error) {
      console.error("Error analyzing document with Textract:", error);
      throw error;
    }
  }

  async function generatePDF(textractResponses, imageBuffers) {
    await fs.mkdir(outputDir, { recursive: true });
    const inputBasename = path.basename(inputKey, path.extname(inputKey));
    const pdfOutputPath = path.join(outputDir, `${inputBasename}_ocr.pdf`);
  
    const doc = new PDFDocument({ margin: 0 });
    const writeStream = fsSync.createWriteStream(pdfOutputPath);
    doc.pipe(writeStream);
  
    for (let i = 0; i < imageBuffers.length; i++) {
      const imageBuffer = imageBuffers[i];
      const textractResponse = textractResponses[i];
  
      const dimensions = await sharp(imageBuffer).metadata();
      const { width, height } = dimensions;
  
      // Ensure that the image fits the PDF page size without cropping.
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
  
      // Scale the image to fit within the PDF page while maintaining aspect ratio
      const scaleFactor = Math.min(pageWidth / width, pageHeight / height);
      const scaledWidth = width * scaleFactor;
      const scaledHeight = height * scaleFactor;
  
      doc.image(imageBuffer, 0, 0, { width: scaledWidth, height: scaledHeight });
      doc.font("Helvetica");
  
      const { Blocks } = textractResponse;
      if (!Blocks || Blocks.length === 0) {
        console.warn("No OCR data found for this page.");
        continue;
      }
  
      Blocks.filter((block) => block.BlockType === "LINE" || block.BlockType === "WORD").forEach((block) => {
        const { Text, Geometry, Confidence } = block;
        if (!Text || !Geometry) return;
  
        const { BoundingBox } = Geometry;
        if (!BoundingBox) return;
  
        const x = BoundingBox.Left * width * scaleFactor;
        const y = BoundingBox.Top * height * scaleFactor;
        const fontSize = Math.max(BoundingBox.Height * height * 0.8 * scaleFactor, 8);
  
        doc.fontSize(fontSize);
        doc.fillColor(Confidence < 90 ? "#666666" : "#000000");
        doc.text(Text, x, y, {
          width: BoundingBox.Width * width * scaleFactor,
          height: BoundingBox.Height * height * scaleFactor,
          lineBreak: false,
        });
      });
  
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
    const getObjectCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: inputKey,
    });
    const response = await s3Client.send(getObjectCommand);
    const buffer = await streamToBuffer(response.Body);

    let imageBuffers = [];
    let textractResponses = [];

    if (inputKey.toLowerCase().endsWith(".pdf")) {
      console.log("Processing PDF...");
      imageBuffers = await extractImagesFromPDF(buffer);

      console.log("Running OCR on extracted images...");
      for (const imageBuffer of imageBuffers) {
        const textractResponse = await analyzeDocument(imageBuffer);
        textractResponses.push(textractResponse);
      }
    } else {
      console.log("Processing image...");
      const textractResponse = await analyzeDocument(buffer);
      textractResponses.push(textractResponse);

      imageBuffers.push(buffer);
    }

    console.log("Generating OCR PDF...");
    const pdfPath = await generatePDF(textractResponses, imageBuffers);

    return {
      success: true,
      message: "Document processed successfully",
      pdfPath,
    };
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
