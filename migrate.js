import { file } from 'bun';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, basename, relative, dirname } from 'node:path';
import { timeStampLog } from './utils/timeStampLog.js';

// Load environment variables (Bun automatically loads .env)
const SLITE_BACKUP_PATH = './slite-backup/channels';
const API_BASE = process.env.OUTLINE_DOMAIN + '/api';
const API_KEY = process.env.OUTLINE_API_KEY;

// Validate environment variables exist
if (!process.env.OUTLINE_DOMAIN || !process.env.OUTLINE_API_KEY) {
  throw new Error('Missing required environment variables: OUTLINE_DOMAIN and/or OUTLINE_API_KEY');
}

// Store mappings for uploaded files and created documents
const attachmentUrlMap = new Map(); // original path -> outline url
const documentUrlMap = new Map();   // original path -> outline url
const documentIdMap = new Map();    // local path -> outline document ID

/**
 * Makes an API request to Outline
 * @param {string} endpoint - API endpoint
 * @param {Object} data - Request payload
 * @returns {Promise<Object>} Response data
 */
async function makeRequest(endpoint, data) {
  const maxRetries = 3;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const response = await fetch(`${API_BASE}/${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      retries++;
      const delay = Math.pow(2, retries) * 1000;
      timeStampLog(`Retry ${retries}/${maxRetries} after ${delay}ms: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error(`Failed after ${maxRetries} retries`);
}

/**
 * Creates a collection in Outline
 * @param {string} name - Collection name
 * @returns {Promise<Object>} Collection data
 */
async function createCollection(name) {
  timeStampLog(`Creating collection: ${name}`);
  const response = await makeRequest('collections.create', {
    name,
    permission: 'read_write'
  });
  return response.data;
}

/**
 * Creates a document in Outline
 * @param {string} title - Document title
 * @param {string} text - Document content
 * @param {string} collectionId - Collection ID
 * @param {string} [parentDocumentId] - Parent document ID for nested docs
 * @returns {Promise<Object>} Document data
 */
async function createDocument(title, text, collectionId, parentDocumentId = null) {
  timeStampLog(`Creating document: ${title}`);
  const data = {
    title,
    text,
    collectionId,
    publish: true
  };

  if (parentDocumentId) {
    data.parentDocumentId = parentDocumentId;
  }

  const response = await makeRequest('documents.create', data);
  return response.data;
}

/**
 * Uploads a file to S3 using the signed URL from Outline
 * @param {Object} attachmentData - Data from attachments.create response
 * @param {ArrayBuffer} fileData - The file data to upload
 * @param {string} mimeType - The file's mime type
 * @returns {Promise<void>}
 */
async function uploadToS3(attachmentData, fileData, mimeType) {
  const { uploadUrl, form } = attachmentData;
  
  const formData = new FormData();
  
  // Add all fields from the form data first
  if (form && typeof form === 'object') {
    Object.entries(form).forEach(([key, value]) => {
      formData.append(key, value);
    });
  }
  
  // Add the file last with the correct field name
  formData.append('file', new Blob([fileData], { type: mimeType }));

  const response = await fetch(uploadUrl, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`S3 upload failed: ${response.status} ${response.statusText} - ${text}`);
  }
}

/**
 * Scans markdown content for links and returns both attachment and document links
 * @param {string} content - Markdown content
 * @param {string} sourcePath - Full path of the markdown file
 * @returns {Object} Object containing attachment and document links with their source paths
 */
function scanMarkdownLinks(content, sourcePath) {
  const linkRegex = /(!?\[(?:[^\]]*)\]\(([^)]+)\))/g;
  const attachmentLinks = new Map(); // Map of link -> source document path
  const documentLinks = new Map();

  for (const match of content.matchAll(linkRegex)) {
    const [, , path] = match;
    if (!path.startsWith('http://') && !path.startsWith('https://')) {
      if (path.endsWith('.md')) {
        documentLinks.set(path, sourcePath);
      } else {
        attachmentLinks.set(path, sourcePath);
      }
    }
  }

  return { attachmentLinks, documentLinks };
}

/**
 * Scans all markdown files in a directory recursively
 * @param {string} dirPath - Directory to scan
 * @returns {Promise<Object>} Object containing all found links
 */
async function scanDirectory(dirPath) {
  const allAttachmentLinks = new Map();
  const allDocumentLinks = new Map();
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = await readFile(fullPath, 'utf-8');
      const { attachmentLinks, documentLinks } = scanMarkdownLinks(content, fullPath);
      attachmentLinks.forEach((sourcePath, link) => allAttachmentLinks.set(link, sourcePath));
      documentLinks.forEach((sourcePath, link) => allDocumentLinks.set(link, sourcePath));
    } else if (entry.isDirectory()) {
      const { attachmentLinks, documentLinks } = await scanDirectory(fullPath);
      attachmentLinks.forEach((sourcePath, link) => allAttachmentLinks.set(link, sourcePath));
      documentLinks.forEach((sourcePath, link) => allDocumentLinks.set(link, sourcePath));
    }
  }

  return { attachmentLinks: allAttachmentLinks, documentLinks: allDocumentLinks };
}

/**
 * Resolves an attachment path relative to its source document
 * @param {string} attachmentPath - The path to the attachment from the markdown
 * @param {string} sourceDocPath - The full path of the source markdown file
 * @returns {string} The full path to the attachment
 */
function resolveAttachmentPath(attachmentPath, sourceDocPath) {
  const sourceDir = dirname(sourceDocPath);
  const decodedPath = decodeURIComponent(attachmentPath);
  
  // If the path includes 'media_', resolve relative to the source directory
  if (decodedPath.includes('media_')) {
    return resolve(sourceDir, decodedPath);
  }
  
  // Otherwise, look for the file in a media folder named after the source document
  const sourceDocName = basename(sourceDocPath, '.md');
  return resolve(sourceDir, `media_${sourceDocName}`, decodedPath);
}

/**
 * Uploads all attachments found in the scan
 * @param {Map<string, string>} attachmentLinks - Map of attachment paths to their source document paths
 */
async function uploadAllAttachments(attachmentLinks) {
  for (const [link, sourcePath] of attachmentLinks.entries()) {
    try {
      const fullPath = resolveAttachmentPath(link, sourcePath);
      
      const f = Bun.file(fullPath);
      if (!await f.exists()) {
        timeStampLog(`File not found: ${fullPath}`);
        continue;
      }

      const fileData = await f.arrayBuffer();
      const fileName = basename(fullPath);
      const ext = fileName.split('.').pop()?.toLowerCase();
      const mimeType = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'pdf': 'application/pdf'
      }[ext] || 'application/octet-stream';

      // Create the attachment record first
      const createResponse = await makeRequest('attachments.create', {
        name: fileName,
        contentType: mimeType,
        size: fileData.byteLength
      });

      if (!createResponse.data?.uploadUrl) {
        throw new Error('No upload URL received from Outline');
      }

      // Upload the file using the signed URL and form data
      await uploadToS3(createResponse.data, fileData, mimeType);

      // Store the mapping of original path to Outline URL
      attachmentUrlMap.set(link, createResponse.data.attachment.url);
      timeStampLog(`Successfully uploaded attachment: ${fileName}`);

    } catch (error) {
      timeStampLog(`Failed to upload attachment ${link}: ${error.message}`);
      // Log more details about the error
      if (error.response) {
        const text = await error.response.text();
        timeStampLog(`Response details: ${text}`);
      }
    }
  }
}

/**
 * Extracts title and content from a markdown document, skipping the first 6 lines
 * and using the first H1 (#) line as the title. That H1 line is removed from
 * the returned content to avoid duplication.
 * 
 * @param {string} content - Raw document content
 * @param {string} fileName - Original file name for fallback title
 * @returns {Object} Object containing title and cleaned content
 */
function parseDocumentContent(content, fileName) {
  // Split into lines and discard first 6 (the metadata)
  const lines = content.split('\n');
  let mainContent = lines.slice(6).join('\n');

  // Look for the first H1 header
  const headerMatch = mainContent.match(/^[ \t]*#\s*(.+?)(?:\n|$)/m);
  let title = '';

  if (headerMatch) {
    title = headerMatch[1].trim();

    // Remove that H1 line from the content
    mainContent = mainContent.replace(/^[ \t]*#\s*(.+?)(?:\n+|$)/m, '');
    // Also remove any leading blank lines after removing the header
    mainContent = mainContent.replace(/^\n+/, '');
  } else {
    // If no H1 header found, use the filename minus extension as fallback
    title = basename(fileName, '.md');
  }

  return { 
    title: title.trim(),
    content: mainContent.trim()
  };
}

/**
 * Creates documents for a directory and its contents
 * @param {string} dirPath - Directory path
 * @param {string} collectionId - Collection ID
 * @param {string} [parentDocumentId] - Parent document ID
 * @returns {Promise<void>}
 */
async function createDocumentStructure(dirPath, collectionId, parentDocumentId = null) {
  const entries = await readdir(dirPath, { withFileTypes: true });

  // Process markdown files first
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const filePath = join(dirPath, entry.name);
      const rawContent = await readFile(filePath, 'utf-8');
      const { title, content } = parseDocumentContent(rawContent, entry.name);

      // Create document
      const doc = await createDocument(title, content, collectionId, parentDocumentId);
      
      // Store the document ID mapped to its local path
      const relativePath = relative(SLITE_BACKUP_PATH, filePath);
      documentIdMap.set(relativePath, doc.id);
      
      // Also store the document URL for link updates
      const docUrl = `/doc/${doc.id}`;
      documentUrlMap.set(relativePath, docUrl);
      
      timeStampLog(`Created document: ${title} with ID: ${doc.id}`);
    }
  }

  // Then process directories
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const fullDirPath = join(dirPath, entry.name);
      
      // Skip media folders
      if (await isMediaFolder(fullDirPath)) {
        timeStampLog(`Skipping media folder: ${entry.name}`);
        continue;
      }

      // Create a document for the directory (acts like a "folder")
      const dirDoc = await createDocument(
        entry.name,
        '', // Empty content for directory documents
        collectionId,
        parentDocumentId
      );

      const relativePath = relative(SLITE_BACKUP_PATH, fullDirPath);
      documentIdMap.set(relativePath, dirDoc.id);
      documentUrlMap.set(relativePath, `/doc/${dirDoc.id}`);

      // Recursively process the subdirectory
      await createDocumentStructure(
        fullDirPath,
        collectionId,
        dirDoc.id
      );
    }
  }
}

/**
 * Updates markdown content with new URLs, skipping first 6 lines and removing
 * the first H1 to remain consistent with how the document was originally created.
 * @param {string} content - Original markdown content
 * @returns {string} Updated content
 */
function updateMarkdownLinks(content) {
  // Discard first 6 lines (metadata)
  const lines = content.split('\n');
  let cleanedContent = lines.slice(6).join('\n');

  // Remove the first H1 line if it exists
  cleanedContent = cleanedContent.replace(/^[ \t]*#\s*(.+?)(?:\n+|$)/m, '');
  cleanedContent = cleanedContent.replace(/^\n+/, '');

  // Now update all links in the cleaned content
  return cleanedContent.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, path) => {
    // If it's already a full URL, leave it alone
    if (path.startsWith('http')) return match;
    
    // Normalize the path (remove leading slash, remove .md, decode)
    const normalizedPath = decodeURIComponent(path.replace(/^\//, '')).replace(/\.md$/, '');
    
    // Check if this path corresponds to a document
    const docUrl = documentUrlMap.get(normalizedPath) || documentUrlMap.get(normalizedPath + '.md');
    if (docUrl) {
      return `[${linkText}](${docUrl})`;
    }
    
    // Check if this path corresponds to an uploaded attachment
    const attachmentUrl = attachmentUrlMap.get(path);
    if (attachmentUrl) {
      return `[${linkText}](${attachmentUrl})`;
    }
    
    // Otherwise return original match
    return match;
  });
}

/**
 * Checks if a directory is a media folder
 * @param {string} dirPath - Directory path to check
 * @returns {Promise<boolean>} True if directory is a media folder
 */
async function isMediaFolder(dirPath) {
  // Check if folder name starts with media_
  if (basename(dirPath).startsWith('media_')) {
    return true;
  }

  // Check if folder only contains media files
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile());
  
  // If there are no files, it's not a media folder
  if (files.length === 0) {
    return false;
  }

  // Check if all files are known media files
  const mediaExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.pdf']);
  return files.every(file => {
    const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
    return ext && mediaExtensions.has(ext);
  });
}

/**
 * Uploads an attachment and associates it with a document
 * @param {string} filePath - Path to the file
 * @param {string} documentId - ID of the document to attach to
 * @returns {Promise<string>} The attachment URL
 */
async function uploadAttachment(filePath, documentId) {
  try {
    const f = Bun.file(filePath);
    const fileData = await f.arrayBuffer();
    const fileName = basename(filePath);
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeType = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'pdf': 'application/pdf'
    }[ext] || 'application/octet-stream';

    // Step 1: Create the attachment record
    const createResponse = await fetch(`${API_BASE}/attachments.create`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: fileName,
        documentId,
        contentType: mimeType,
        size: fileData.byteLength,
        preset: 'documentAttachment'
      })
    });

    if (!createResponse.ok) {
      const text = await createResponse.text();
      throw new Error(`Failed to create attachment: ${createResponse.status} ${text}`);
    }

    const responseData = await createResponse.json();
    
    if (!responseData.data?.uploadUrl) {
      throw new Error(`No upload URL in response: ${JSON.stringify(responseData)}`);
    }

    // Step 2: Upload to S3
    const formData = new FormData();
    
    // Add all fields from the form data first
    if (responseData.data.form) {
      Object.entries(responseData.data.form).forEach(([key, value]) => {
        formData.append(key, value);
      });
    }
    
    // Add the file last
    formData.append('file', new Blob([fileData], { type: mimeType }), fileName);

    const uploadUrl = responseData.data.uploadUrl.startsWith('http') 
      ? responseData.data.uploadUrl 
      : `${process.env.OUTLINE_DOMAIN}${responseData.data.uploadUrl}`;

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      },
      body: formData
    });

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text();
      throw new Error(`Failed to upload to S3: ${uploadResponse.status} ${text}`);
    }

    return responseData.data.attachment.url;
  } catch (error) {
    timeStampLog(`Error in uploadAttachment: ${error.message}`);
    throw error;
  }
}

/**
 * Main migration function
 */
async function migrate() {
  try {
    timeStampLog('Starting migration...');

    // Phase 1: Create all documents first
    timeStampLog('Creating document structure...');
    const channels = await readdir(SLITE_BACKUP_PATH, { withFileTypes: true });

    for (const channel of channels) {
      if (channel.isDirectory()) {
        const collection = await createCollection(channel.name);
        await createDocumentStructure(
          join(SLITE_BACKUP_PATH, channel.name),
          collection.id
        );
      }
    }

    // Phase 2: Scan for attachments and upload them
    timeStampLog('Scanning for attachments...');
    const { attachmentLinks } = await scanDirectory(SLITE_BACKUP_PATH);

    for (const [link, sourcePath] of attachmentLinks.entries()) {
      try {
        // Get the document ID for this attachment
        const relativeSourcePath = relative(SLITE_BACKUP_PATH, sourcePath);
        const documentId = documentIdMap.get(relativeSourcePath);

        if (!documentId) {
          timeStampLog(`No document ID found for ${relativeSourcePath}`);
          continue;
        }

        const fullPath = resolveAttachmentPath(link, sourcePath);
        
        // Check if file exists before trying to upload
        const f = Bun.file(fullPath);
        if (!await f.exists()) {
          timeStampLog(`File not found: ${fullPath}`);
          continue;
        }

        const attachmentUrl = await uploadAttachment(fullPath, documentId);
        attachmentUrlMap.set(link, attachmentUrl);
        
        timeStampLog(`Successfully uploaded attachment for document ${documentId}`);
      } catch (error) {
        timeStampLog(`Failed to upload attachment ${link}: ${error.message}`);
      }
    }

    // Phase 3: Update all documents with correct links
    timeStampLog('Updating document links...');
    for (const [docPath, docId] of documentIdMap.entries()) {
      try {
        const fullPath = join(SLITE_BACKUP_PATH, docPath);
        
        // Check if it's a file and ends with .md before trying to read
        const stats = await stat(fullPath);
        if (!stats.isFile() || !docPath.endsWith('.md')) {
          continue;
        }

        const content = await readFile(fullPath, 'utf-8');
        const updatedContent = updateMarkdownLinks(content);

        // Update the document with new content
        await makeRequest('documents.update', {
          id: docId,
          text: updatedContent
        });
      } catch (error) {
        timeStampLog(`Failed to update document ${docPath}: ${error.message}`);
      }
    }

    timeStampLog('Migration completed successfully!');
  } catch (error) {
    timeStampLog(`Migration failed: ${error.message}`);
    throw error;
  }
}

// Run the migration
migrate().catch(error => {
  timeStampLog(`Fatal error: ${error.message}`);
  process.exit(1);
});
