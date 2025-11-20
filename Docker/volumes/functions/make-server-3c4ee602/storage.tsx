import { createClient } from "npm:@supabase/supabase-js@2";
import type { Context } from "npm:hono";
import { sendToKafka, createKafkaErrorFile } from "./kafka.tsx";

const BUCKET_NAME = "make-3c4ee602-invoices";
const BASE_URL = "https://dentsudev-baas.dmacq.app";
const DEFAULT_VENDOR_ID = "17236c70-d7f7-4b64-8761-607f5d957193";

// Initialize Supabase client (supports both cloud and self-hosted)
const getSupabaseClient = () => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  
  if (!url || !key) {
    console.error("❌ CRITICAL: Supabase credentials missing!");
    console.error(`   SUPABASE_URL: ${url ? "✓ Set" : "✗ Missing"}`);
    console.error(`   SUPABASE_SERVICE_ROLE_KEY: ${key ? "✓ Set" : "✗ Missing"}`);
    throw new Error("Supabase credentials not configured");
  }
  
  console.log(`✅ Supabase client initialized: ${url}`);
  
  // For self-hosted Supabase, we may need additional options
  // Check if it's a self-hosted instance (not *.supabase.co)
  const isSelfHosted = !url.includes('.supabase.co');
  
  const clientOptions: any = {
    auth: {
      persistSession: false, // Don't persist sessions in edge functions
      autoRefreshToken: false, // Don't auto-refresh tokens
    },
  };
  
  // For self-hosted instances, we might need to handle SSL/certificates differently
  if (isSelfHosted) {
    console.log("🔧 Self-hosted Supabase detected, using custom configuration");
    // You can add custom fetch options here if needed for self-hosted instances
    // For example, if you have SSL certificate issues:
    // clientOptions.global = {
    //   fetch: (url, options) => {
    //     // Custom fetch implementation for self-hosted
    //   }
    // };
  }
  
  return createClient(url, key, clientOptions);
};

// Get the allowed MIME types list
const getAllowedMimeTypes = () => [
  // Images
  "image/jpeg",
  "image/png",
  "image/jpg",
  "image/gif",
  "image/webp",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  // Fallback - allow octet-stream to prevent upload failures
  "application/octet-stream",
];

// Initialize storage bucket (idempotent)
export const initializeBucket = async () => {
  const supabase = getSupabaseClient();
  
  try {
    // Check if bucket exists
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    
    if (listError) {
      console.error("Error listing buckets:", listError);
      // Continue anyway - we'll try to create and handle the error
    }
    
    // Log all existing buckets for debugging
    if (buckets && buckets.length > 0) {
      console.log("Existing buckets:", buckets.map(b => b.name).join(", "));
    }
    
    const bucketExists = buckets?.some((bucket) => bucket.name === BUCKET_NAME);

    if (!bucketExists) {
      console.log(`Creating storage bucket: ${BUCKET_NAME}`);
      const { data, error } = await supabase.storage.createBucket(BUCKET_NAME, {
        public: false, // Private bucket - requires signed URLs
        fileSizeLimit: 52428800, // 50MB limit
        allowedMimeTypes: getAllowedMimeTypes(),
      });

      if (error) {
        // Check if error is "bucket already exists" (409)
        if (error.statusCode === "409" || error.message?.includes("already exists")) {
          console.log(`Bucket already exists (409 error): ${BUCKET_NAME} - This is OK`);
          return; // Bucket exists, we're good
        }
        console.error("Error creating bucket:", error);
        throw error;
      }
      
      console.log(`✅ Bucket created successfully: ${BUCKET_NAME}`);
    } else {
      console.log(`✅ Bucket already exists: ${BUCKET_NAME}`);
    }
  } catch (error: any) {
    // Handle "bucket already exists" error gracefully
    if (error.statusCode === "409" || error.message?.includes("already exists")) {
      console.log(`✅ Bucket already exists (caught in catch): ${BUCKET_NAME} - This is OK`);
      return; // Bucket exists, we're good
    }
    console.error("❌ Error in initializeBucket:", error);
    // Don't throw - allow server to continue even if bucket init fails
    // The upload will fail with a better error message if bucket truly doesn't exist
  }
};

// Update bucket MIME types - call this endpoint to fix MIME type errors
export const updateBucketMimeTypes = async (c: Context) => {
  const supabase = getSupabaseClient();
  
  try {
    console.log(`🔧 Updating MIME types for bucket: ${BUCKET_NAME}`);
    
    const { data, error } = await supabase.storage.updateBucket(BUCKET_NAME, {
      allowedMimeTypes: getAllowedMimeTypes(),
      fileSizeLimit: 52428800, // 50MB
      public: false,
    });
    
    if (error) {
      console.error("❌ Error updating bucket:", error);
      return c.json({ 
        success: false, 
        error: error.message,
        hint: "Try running the SQL script UPDATE_BUCKET_MIME_TYPES.sql in Supabase SQL Editor"
      }, 500);
    }
    
    console.log("✅ Bucket MIME types updated successfully");
    return c.json({ 
      success: true, 
      message: "Bucket MIME types updated successfully",
      allowedMimeTypes: getAllowedMimeTypes()
    });
  } catch (error: any) {
    console.error("❌ Error in updateBucketMimeTypes:", error);
    return c.json({ 
      success: false, 
      error: error.message,
      hint: "Try running the SQL script UPDATE_BUCKET_MIME_TYPES.sql in Supabase SQL Editor"
    }, 500);
  }
};

// Upload file to storage
export const uploadFile = async (c: Context) => {
  const supabase = getSupabaseClient();
  
  // Store values for error handling
  let fileName = "unknown";
  let vendorIdToUse = DEFAULT_VENDOR_ID;
  let invoiceId = "";
  
  try {
    const body = await c.req.json();
    const { fileName: bodyFileName, fileData, invoiceId: bodyInvoiceId, vendorId } = body;
    fileName = bodyFileName || "unknown";
    invoiceId = bodyInvoiceId || "";
    vendorIdToUse = vendorId || DEFAULT_VENDOR_ID;

    console.log(`📤 Upload request - Invoice: ${invoiceId}, File: ${fileName}`);

    if (!bodyFileName || !fileData || !invoiceId) {
      console.error("❌ Missing required fields");
      return c.json(
        { error: "Missing required fields: fileName, fileData, invoiceId" },
        400
      );
    }

    // Convert base64 to Uint8Array
    const base64Data = fileData.split(",")[1] || fileData;
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    console.log(`📦 File size: ${bytes.length} bytes (${(bytes.length / 1024).toFixed(2)} KB)`);

    // Create a unique file path: invoices/{invoiceId}/{timestamp}-{fileName}
    const timestamp = Date.now();
    const filePath = `invoices/${invoiceId}/${timestamp}-${fileName}`;

    // Determine content type
    const contentType = getContentType(fileName);
    console.log(`📁 Uploading to bucket: ${BUCKET_NAME}, path: ${filePath}`);
    console.log(`📋 Content-Type: ${contentType}, File: ${fileName}`);

    // Upload to Supabase Storage
    let data, error;
    try {
      const uploadResult = await supabase.storage
        .from(BUCKET_NAME)
        .upload(filePath, bytes, {
          contentType: contentType,
          upsert: false,
        });
      data = uploadResult.data;
      error = uploadResult.error;
    } catch (uploadException: any) {
      console.error(`❌ EXCEPTION during upload for ${fileName}:`, uploadException);
      console.error(`   Exception type: ${uploadException.constructor.name}`);
      console.error(`   Exception message: ${uploadException.message}`);
      if (uploadException.originalError) {
        console.error(`   Original error: ${uploadException.originalError.message}`);
      }
      // Handle exception by creating Kafka error file
      await createKafkaErrorFile(invoiceId || "", vendorIdToUse, "", fileName, uploadException);
      return c.json({ 
        error: `Upload exception: ${uploadException.message}. This usually means Supabase credentials are invalid or the project doesn't exist.`,
        hint: "Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables"
      }, 500);
    }

    if (error) {
      console.error(`❌ Upload failed for ${fileName}:`, error);
      console.error(`   Error details - Status: ${error.statusCode}, Message: ${error.message}`);
      
      // Handle exception by creating Kafka error file
      await createKafkaErrorFile(invoiceId || "", vendorIdToUse, "", fileName, error);
      
      // Check if bucket doesn't exist
      if (error.statusCode === "404" || error.message?.includes("Bucket not found")) {
        console.error(`   Bucket "${BUCKET_NAME}" not found! Attempting to create it...`);
        await initializeBucket();
        console.log(`   Bucket initialized. Please retry the upload.`);
        return c.json({ 
          error: `Bucket was not initialized. Please retry the upload.`,
          retryable: true 
        }, 500);
      }
      
      return c.json({ error: `Upload failed: ${error.message}` }, 500);
    }

    console.log(`✅ File uploaded successfully: ${filePath}`);
    
    // Get signed URL for the uploaded file
    let signedUrl = "";
    try {
      const { data: urlData, error: urlError } = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(data.path, 3600); // Valid for 1 hour
      
      if (urlError) {
        console.error(`⚠️ Failed to generate signed URL:`, urlError);
        // Fallback to constructed URL if signed URL fails
        const pathWithSlash = data.path.startsWith("/") ? data.path : `/${data.path}`;
        signedUrl = `${BASE_URL}${pathWithSlash}`;
      } else {
        signedUrl = urlData.signedUrl;
        console.log(`✅ Signed URL generated successfully`);
      }
    } catch (urlException: any) {
      console.error(`⚠️ Exception generating signed URL:`, urlException);
      // Fallback to constructed URL if signed URL fails
      const pathWithSlash = data.path.startsWith("/") ? data.path : `/${data.path}`;
      signedUrl = `${BASE_URL}${pathWithSlash}`;
    }
    
    // Send to Kafka after successful upload
    try {
      await sendToKafka(invoiceId, vendorIdToUse, signedUrl, fileName);
    } catch (kafkaError: any) {
      console.error(`❌ Failed to send to Kafka, but file uploaded successfully:`, kafkaError);
      // Don't fail the upload if Kafka fails - file is already uploaded
    }
    
    return c.json({
      success: true,
      path: data.path,
      fileName: fileName,
    });
  } catch (error: any) {
    console.error("❌ Error in uploadFile:", error);
    // Handle exception by creating Kafka error file
    try {
      await createKafkaErrorFile(invoiceId || "", vendorIdToUse, "", fileName, error);
    } catch (kafkaError: any) {
      console.error(`❌ Failed to create Kafka error file:`, kafkaError);
    }
    return c.json({ error: `Upload error: ${error.message}` }, 500);
  }
};

// Helper function to parse signed URL and extract bucket and file path
function parseSignedUrl(url: string): { bucket: string; filePath: string } | null {
  try {
    // Pattern: https://domain/storage/v1/object/sign/{bucket}/{filePath}?token=...
    // Example: https://dentsudev-baas.dmacq.app/storage/v1/object/sign/make-3c4ee602-invoices/invoices/1763448216989/1763448218651-1025260307915%20(3).pdf?token=...
    
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // Extract path after /storage/v1/object/sign/
    const prefix = '/storage/v1/object/sign/';
    if (!pathname.startsWith(prefix)) {
      return null;
    }
    
    const pathAfterPrefix = pathname.substring(prefix.length);
    const parts = pathAfterPrefix.split('/');
    
    if (parts.length < 2) {
      return null;
    }
    
    // First part is the bucket name
    const bucket = parts[0];
    
    // Everything after the bucket is the file path
    const filePathParts = parts.slice(1);
    let filePath = filePathParts.join('/');
    
    // Decode URL encoding (e.g., %20 -> space, %28 -> (, %29 -> ))
    filePath = decodeURIComponent(filePath);
    
    return { bucket, filePath };
  } catch (error) {
    console.error("Error parsing signed URL:", error);
    return null;
  }
}

// Get signed URL for file preview
export const getSignedUrl = async (c: Context) => {
  const supabase = getSupabaseClient();
  
  try {
    const body = await c.req.json();
    const { filePath, signedUrl: inputSignedUrl } = body;

    // Accept either filePath or a full signed URL
    let bucketToUse = BUCKET_NAME;
    let pathToUse = "";

    // Check if inputSignedUrl is provided
    if (inputSignedUrl) {
      // Parse the existing signed URL to extract bucket and file path
      const parsed = parseSignedUrl(inputSignedUrl);
      if (parsed) {
        bucketToUse = parsed.bucket;
        pathToUse = parsed.filePath;
        console.log(`📋 Parsed signed URL from 'signedUrl' field - Bucket: ${bucketToUse}, Path: ${pathToUse}`);
      } else {
        return c.json({ 
          error: "Invalid signed URL format. Expected: /storage/v1/object/sign/{bucket}/{filePath}?token=..." 
        }, 400);
      }
    } else if (filePath) {
      // Check if filePath is actually a full URL (starts with http:// or https://)
      if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        // Parse the URL to extract bucket and file path
        const parsed = parseSignedUrl(filePath);
        if (parsed) {
          bucketToUse = parsed.bucket;
          pathToUse = parsed.filePath;
          console.log(`📋 Parsed signed URL from 'filePath' field - Bucket: ${bucketToUse}, Path: ${pathToUse}`);
        } else {
          return c.json({ 
            error: "Invalid signed URL format in filePath. Expected: https://.../storage/v1/object/sign/{bucket}/{filePath}?token=..." 
          }, 400);
        }
      } else {
        // Use provided file path directly (not a URL)
        pathToUse = filePath;
        console.log(`📁 Using file path directly: ${pathToUse}`);
      }
    } else {
      return c.json({ error: "Missing filePath or signedUrl" }, 400);
    }

    if (!pathToUse) {
      return c.json({ error: "Could not determine file path" }, 400);
    }

    console.log(`🔐 Generating new signed URL for bucket: ${bucketToUse}, path: ${pathToUse}`);

    // Verify Supabase credentials are available
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!supabaseUrl || !supabaseKey) {
      console.error("❌ Supabase credentials missing!");
      return c.json({ 
        error: "Invalid authentication credentials",
        message: "Supabase credentials not configured. Please check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables."
      }, 401);
    }
    
    // Log diagnostic information for self-hosted instances
    const isSelfHosted = !supabaseUrl.includes('.supabase.co');
    if (isSelfHosted) {
      console.log(`🔧 Self-hosted Supabase detected`);
      console.log(`   URL: ${supabaseUrl}`);
      console.log(`   Key length: ${supabaseKey.length} characters`);
      console.log(`   Key starts with: ${supabaseKey.substring(0, 20)}...`);
    }

    // Generate signed URL valid for 1 hour (3600 seconds)
    const { data, error } = await supabase.storage
      .from(bucketToUse)
      .createSignedUrl(pathToUse, 3600);

    if (error) {
      console.error("❌ Error generating signed URL:", error);
      console.error("   Error details:", JSON.stringify(error, null, 2));
      
      // Check for specific error types
      if (error.message?.includes("Invalid authentication") || error.message?.includes("JWT")) {
        return c.json({ 
          error: "Invalid authentication credentials",
          message: error.message || "Authentication failed. Please check SUPABASE_SERVICE_ROLE_KEY.",
          details: {
            bucket: bucketToUse,
            path: pathToUse,
            errorCode: error.statusCode || error.code
          }
        }, 401);
      }
      
      if (error.message?.includes("not found") || error.message?.includes("does not exist")) {
        return c.json({ 
          error: "File or bucket not found",
          message: error.message,
          details: {
            bucket: bucketToUse,
            path: pathToUse
          }
        }, 404);
      }
      
      return c.json({ 
        error: `Failed to generate URL: ${error.message}`,
        message: error.message,
        details: {
          bucket: bucketToUse,
          path: pathToUse,
          errorCode: error.statusCode || error.code
        }
      }, 500);
    }

    if (!data || !data.signedUrl) {
      console.error("❌ No signed URL returned from Supabase");
      return c.json({ 
        error: "Failed to generate signed URL",
        message: "Supabase returned no data"
      }, 500);
    }

    console.log(`✅ Signed URL generated successfully`);

    return c.json({
      success: true,
      signedUrl: data.signedUrl,
      bucket: bucketToUse,
      filePath: pathToUse,
    });
  } catch (error: any) {
    console.error("❌ Error in getSignedUrl:", error);
    console.error("   Error stack:", error.stack);
    
    // Check if it's an authentication error
    if (error.message?.includes("Invalid authentication") || error.message?.includes("credentials")) {
      return c.json({ 
        error: "Invalid authentication credentials",
        message: error.message || "Authentication failed. Please check environment variables."
      }, 401);
    }
    
    return c.json({ 
      error: `URL generation error: ${error.message}`,
      message: error.message
    }, 500);
  }
};

// Delete file from storage
export const deleteFile = async (c: Context) => {
  const supabase = getSupabaseClient();
  
  try {
    const { filePath } = await c.req.json();

    if (!filePath) {
      return c.json({ error: "Missing filePath" }, 400);
    }

    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .remove([filePath]);

    if (error) {
      console.error("Error deleting file:", error);
      return c.json({ error: `Delete failed: ${error.message}` }, 500);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error("Error in deleteFile:", error);
    return c.json({ error: `Delete error: ${error.message}` }, 500);
  }
};

// Helper function to determine content type
function getContentType(fileName: string): string {
  const extension = fileName.toLowerCase().split(".").pop();
  
  const mimeTypes: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    // Add more common formats
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
  };

  const contentType = mimeTypes[extension || ""];
  
  if (!contentType) {
    console.warn(`⚠️ Unknown file extension: ${extension}, defaulting to application/pdf`);
    // Default to PDF for unknown types to avoid rejection
    return "application/pdf";
  }
  
  return contentType;
}

