import { Context } from "npm:hono";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as kv from "./kv_store.tsx";
import { sendToKafka } from "./kafka.tsx";

// Types matching the frontend Invoice interface
export interface Invoice {
  id: string;
  
  // Section 1: Invoice Data Extraction Fields (25 fields from KlearStack API)
  fileName: string;
  vendorName: string;
  dentsuEntity: string;
  docType: string;
  status: "Processing" | "Failed" | "Pending" | "Disputed" | "Accepted" | "Rejected";
  supportedDocs: string;
  submission_date: string;
  pendingDays: number | null;
  docDate: string;
  docNo: string;
  splitInvoiceNo: string;
  currencyCode: string;
  invoiceAmountWithoutTax: string;
  totalTaxAmount: string;
  invoiceAmountWithTax: string;
  poRoNo: string;
  vendorGSTNo: string;
  vendorState: string;
  vendorPANNo: string;
  billToGSTNo: string;
  placeOfSupply: string;
  bankAccountNo: string;
  vendorPINCode: string;
  dentsuPINCode: string;
  cinNo: string;
  
  // Section 2: QR Code Data Extraction Fields (10 fields)
  irnNumber: string;
  irnDate: string;
  acknowledgementNumber: string;
  acknowledgementDate: string;
  irnSellerGstin: string;
  buyerGstin: string;
  qrDocNo: string;
  qrDocTyp: string;
  qrDocDt: string;
  totInvValItemCnt: string;
  mainHsnCode: string;
  
  // Legacy fields for compatibility
  invoiceNumber?: string;
  currency?: string;
  totalAmount?: string;
  
  // Additional metadata
  comment?: string;
  rejectionReason?: string;
  uploadedBy?: string;
  approvedBy?: string;
  rejectedBy?: string;
  actionDate?: string;
  fileUrl?: string;
  supportingDocsUrls?: string[];
}

const BASE_URL = "https://dentsudev-baas.dmacq.app";

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
  
  return createClient(url, key);
};

// Get all invoices
export async function getInvoices(c: Context) {
  try {
    console.log("📊 Fetching all invoices from database");
    
    // Get Supabase client
    const supabase = getSupabaseClient();
    
    // Get query parameters for PostgREST compatibility
    const selectParam = c.req.query("select") || "*";
    const orderParam = c.req.query("order");
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    
    // Build query
    let query = supabase.from("invoices").select(selectParam);
    
    // Handle ordering
    if (orderParam) {
      // Parse order parameter (format: "column.asc" or "column.desc")
      const [column, direction] = orderParam.split(".");
      if (column) {
        query = query.order(column, { ascending: direction !== "desc" });
      }
    }
    
    // Handle limit
    if (limitParam) {
      const limit = parseInt(limitParam, 10);
      if (!isNaN(limit) && limit > 0) {
        query = query.limit(limit);
      }
    }
    
    // Handle offset
    if (offsetParam) {
      const offset = parseInt(offsetParam, 10);
      if (!isNaN(offset) && offset >= 0) {
        query = query.range(offset, offset + (parseInt(limitParam || "100", 10) - 1));
      }
    }
    
    // Execute query
    const { data: invoices, error } = await query;
    
    if (error) {
      console.error("❌ Error fetching invoices from database:", error);
      return c.json({ 
        success: false, 
        error: `Failed to fetch invoices: ${error.message}` 
      }, 500);
    }
    
    console.log(`✅ Found ${invoices?.length || 0} invoices`);
    
    // Return in REST API format (direct array, not wrapped)
    // This matches the Supabase REST API response format
    return c.json(invoices || []);
  } catch (error) {
    console.error("❌ Error fetching invoices:", error);
    return c.json({ 
      success: false, 
      error: `Failed to fetch invoices: ${error}` 
    }, 500);
  }
}

// Get invoices count
export async function getInvoicesCount(c: Context) {
  try {
    console.log("📊 Fetching invoices count from database");
    
    // Get Supabase client
    const supabase = getSupabaseClient();
    
    // Get count using Supabase client - head: true means we only get the count, not the data
    const { count, error } = await supabase
      .from("invoices")
      .select("*", { count: "exact", head: true });
    
    if (error) {
      console.error("❌ Error fetching invoices count from database:", error);
      return c.json({
        error: "Failed to fetch invoices count",
        detail: error.message
      }, 500);
    }
    
    console.log(`✅ Found ${count || 0} invoices`);
    
    return c.json({
      count: count || 0
    });
  } catch (err) {
    console.error("❌ Error in invoices-count:", err);
    return c.json({
      error: "internal_error",
      detail: String(err)
    }, 500);
  }
}

// Get status counts for status cards
export async function getInvoicesStatusCounts(c: Context) {
  try {
    console.log("📊 Fetching status counts for status cards");
    
    // Get Supabase client
    const supabase = getSupabaseClient();
    
    // Get submitted count from submissions table
    // Statuses: validation_in_progress, validation_failed, uploading, upload_failed, uploaded
    const submittedStatuses = [
      "validation_in_progress",
      "validation_failed",
      "uploading",
      "upload_failed",
      "uploaded",
    ];
    
    const { count: submittedCount, error: submittedError } = await supabase
      .from("submissions")
      .select("*", { count: "exact", head: true })
      .in("status", submittedStatuses);
    
    if (submittedError) {
      console.error("❌ Error fetching submitted count:", submittedError);
      return c.json({
        error: "Failed to fetch submitted count",
        detail: submittedError.message
      }, 500);
    }
    
    // Get pending count from invoices table (status = "Extracted")
    const { count: pendingCount, error: pendingError } = await supabase
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .eq("status", "Extracted");
    
    if (pendingError) {
      console.error("❌ Error fetching pending count:", pendingError);
      return c.json({
        error: "Failed to fetch pending count",
        detail: pendingError.message
      }, 500);
    }
    
    // Get disputed count from invoices table
    // Status = "Disputed" OR has_active_disputes = true
    const { count: disputedCount, error: disputedError } = await supabase
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .or("status.eq.Disputed,has_active_disputes.eq.true");
    
    if (disputedError) {
      console.error("❌ Error fetching disputed count:", disputedError);
      return c.json({
        error: "Failed to fetch disputed count",
        detail: disputedError.message
      }, 500);
    }
    
    // Get accepted count from invoices table (status = "Accepted" or "Success")
    const { count: acceptedCount, error: acceptedError } = await supabase
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .in("status", ["Accepted", "Success"]);
    
    if (acceptedError) {
      console.error("❌ Error fetching accepted count:", acceptedError);
      return c.json({
        error: "Failed to fetch accepted count",
        detail: acceptedError.message
      }, 500);
    }
    
    // Get rejected count from invoices table (status = "Rejected")
    const { count: rejectedCount, error: rejectedError } = await supabase
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .eq("status", "Rejected");
    
    if (rejectedError) {
      console.error("❌ Error fetching rejected count:", rejectedError);
      return c.json({
        error: "Failed to fetch rejected count",
        detail: rejectedError.message
      }, 500);
    }
    
    console.log(`✅ Status counts - Submitted: ${submittedCount || 0}, Pending: ${pendingCount || 0}, Disputed: ${disputedCount || 0}, Accepted: ${acceptedCount || 0}, Rejected: ${rejectedCount || 0}`);
    
    return c.json({
      submitted: submittedCount || 0,
      pending: pendingCount || 0,
      disputed: disputedCount || 0,
      accepted: acceptedCount || 0,
      rejected: rejectedCount || 0,
    });
  } catch (err) {
    console.error("❌ Error in invoices-status-counts:", err);
    return c.json({
      error: "internal_error",
      detail: String(err)
    }, 500);
  }
}

// Get single invoice by ID
export async function getInvoice(c: Context) {
  try {
    const id = c.req.param("id");
    console.log(`📄 Fetching invoice with ID: ${id}`);
    
    const invoice = await kv.get(`invoice:${id}`);
    
    if (!invoice) {
      console.log(`⚠️ Invoice not found: ${id}`);
      return c.json({ 
        success: false, 
        error: "Invoice not found" 
      }, 404);
    }
    
    console.log(`✅ Invoice found: ${id}`);
    return c.json({ success: true, data: invoice });
  } catch (error) {
    console.error("❌ Error fetching invoice:", error);
    return c.json({ 
      success: false, 
      error: `Failed to fetch invoice: ${error}` 
    }, 500);
  }
}

// Create new invoice
export async function createInvoice(c: Context) {
  try {
    const invoiceData = await c.req.json();
    console.log("📝 Creating new invoice:", invoiceData.fileName);
    
    const { id: _, ...invoiceDataWithoutId } = invoiceData;
    
    const invoice: Omit<Invoice, 'id'> & { id?: string } = {
      ...invoiceDataWithoutId,
      submission_date: new Date().toISOString(),
      status: invoiceData.status || "Pending",
    };
    
    // Get Supabase client
    const supabase = getSupabaseClient();
    
    // Save to database table - ID will be generated by database
    const { data: insertedInvoice, error: dbError } = await supabase
      .from("invoices")
      .insert(invoice)
      .select()
      .single();
    
    if (dbError) {
      console.error("❌ Error saving invoice to database:", dbError);
      return c.json({ 
        success: false, 
        error: `Failed to create invoice: ${dbError.message}` 
      }, 500);
    }
    
    // Get the ID from the database after insertion
    const invoiceId = insertedInvoice?.id;
    if (!invoiceId) {
      console.error("❌ Error: Invoice created but no ID returned from database");
      return c.json({ 
        success: false, 
        error: `Failed to create invoice: No ID returned from database` 
      }, 500);
    }
    
    // Use file_url from request body and append BASE_URL with storage path
    let fileUrl = "";
    if (invoiceData.file_url) {
      fileUrl = `${BASE_URL}/storage/v1/object/public/make-3c4ee602-invoices/${invoiceData.file_url}`;
      if (insertedInvoice) {
        insertedInvoice.fileUrl = fileUrl;
      }
    }
    
    // Also save to KV store as backup/cache
    // try {
    //   await kv.set(`invoice:${invoiceId}`, insertedInvoice);
    // } catch (kvError) {
    //   console.warn("⚠️ Failed to save to KV store (non-critical):", kvError);
    //   // Don't fail the request if KV store fails
    // }
    
    const response = c.json(insertedInvoice, 201);
    
    const vendorIdToUse = invoiceData.user_id || "17236c70-d7f7-4b64-8761-607f5d957193"; // Default vendor ID
    const fileName = invoiceData.file_name || invoiceData.fileName || "";
    
    sendToKafka(invoiceId, vendorIdToUse, fileUrl, fileName).catch((kafkaError: any) => {
      console.error(`❌ Failed to send to Kafka (non-critical):`, kafkaError);
    });
    
    return response;

  } catch (error) {
    console.error("❌ Error creating invoice:", error);
    return c.json({ 
      success: false, 
      error: `Failed to create invoice: ${error}` 
    }, 500);
  }
}

// Update invoice
export async function updateInvoice(c: Context) {
  try {
    const id = c.req.param("id");
    const updates = await c.req.json();
    console.log(`✏️ Updating invoice: ${id}`);
    
    // Get existing invoice
    const existing = await kv.get(`invoice:${id}`);
    
    if (!existing) {
      console.log(`⚠️ Invoice not found for update: ${id}`);
      return c.json({ 
        success: false, 
        error: "Invoice not found" 
      }, 404);
    }
    
    // Merge updates with existing data
    const updated: Invoice = {
      ...existing,
      ...updates,
      id, // Ensure ID doesn't change
    };
    
    // Save updated invoice
    await kv.set(`invoice:${id}`, updated);
    
    console.log(`✅ Invoice updated successfully: ${id}`);
    return c.json({ success: true, data: updated });
  } catch (error) {
    console.error("❌ Error updating invoice:", error);
    return c.json({ 
      success: false, 
      error: `Failed to update invoice: ${error}` 
    }, 500);
  }
}

// Delete invoice
export async function deleteInvoice(c: Context) {
  try {
    const id = c.req.param("id");
    console.log(`🗑️ Deleting invoice: ${id}`);
    
    // Check if invoice exists
    const existing = await kv.get(`invoice:${id}`);
    
    if (!existing) {
      console.log(`⚠️ Invoice not found for deletion: ${id}`);
      return c.json({ 
        success: false, 
        error: "Invoice not found" 
      }, 404);
    }
    
    // Delete from KV store
    await kv.del(`invoice:${id}`);
    
    console.log(`✅ Invoice deleted successfully: ${id}`);
    return c.json({ success: true, message: "Invoice deleted" });
  } catch (error) {
    console.error("❌ Error deleting invoice:", error);
    return c.json({ 
      success: false, 
      error: `Failed to delete invoice: ${error}` 
    }, 500);
  }
}

// Bulk create invoices
export async function bulkCreateInvoices(c: Context) {
  try {
    const { invoices } = await c.req.json();
    
    // Filter out null/undefined invoices
    const validInvoices = (invoices || []).filter((inv: any) => 
      inv !== null && 
      inv !== undefined && 
      typeof inv === 'object' &&
      inv.id
    );
    
    console.log(`📦 Bulk creating ${validInvoices.length} invoices (${(invoices?.length || 0) - validInvoices.length} invalid filtered)`);
    
    const created: Invoice[] = [];
    const keys: string[] = [];
    const values: Invoice[] = [];
    
    for (const invoiceData of validInvoices) {
      const id = invoiceData.id || `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const invoice: Invoice = {
        ...invoiceData,
        id,
        submission_date: invoiceData.submission_date || new Date().toISOString(),
        status: invoiceData.status || "Pending",
      };
      
      keys.push(`invoice:${id}`);
      values.push(invoice);
      created.push(invoice);
    }
    
    // Use mset for efficient bulk insert
    if (keys.length > 0) {
      await kv.mset(keys, values);
    }
    
    console.log(`✅ Bulk created ${created.length} invoices successfully`);
    return c.json({ 
      success: true, 
      data: created,
      count: created.length 
    }, 201);
  } catch (error) {
    console.error("❌ Error bulk creating invoices:", error);
    return c.json({ 
      success: false, 
      error: `Failed to bulk create invoices: ${error}` 
    }, 500);
  }
}

// Get invoices by status
export async function getInvoicesByStatus(c: Context) {
  try {
    const status = c.req.param("status");
    console.log(`📊 Fetching invoices with status: ${status}`);
    
    // Get all invoices
    const allInvoices = await kv.getByPrefix("invoice:");
    
    // Filter out nulls and filter by status
    const filtered = allInvoices
      .filter(invoice => 
        invoice !== null && 
        invoice !== undefined && 
        typeof invoice === 'object'
      )
      .filter(invoice => invoice.status === status);
    
    console.log(`✅ Found ${filtered.length} invoices with status ${status}`);
    
    return c.json({ 
      success: true, 
      data: filtered,
      count: filtered.length 
    });
  } catch (error) {
    console.error("❌ Error fetching invoices by status:", error);
    return c.json({ 
      success: false, 
      error: `Failed to fetch invoices by status: ${error}` 
    }, 500);
  }
}

// Process invoice with Klearstack API
export async function processInvoiceWithKlearstack(c: Context) {
  try {
    const id = c.req.param("id");
    const { fileData, fileName } = await c.req.json();
    
    console.log(`🔄 Processing invoice with Klearstack: ${id}`);
    
    // Get existing invoice
    const invoice = await kv.get(`invoice:${id}`);
    
    if (!invoice) {
      return c.json({ 
        success: false, 
        error: "Invoice not found" 
      }, 404);
    }
    
    // Get Klearstack API key from environment
    const klearstackApiKey = Deno.env.get('KLEARSTACK_API_KEY');
    const klearstackApiUrl = Deno.env.get('KLEARSTACK_API_URL') || 'https://api.klearstack.com/v1';
    
    if (!klearstackApiKey) {
      console.warn('⚠️ Klearstack API key not configured, storing for later processing');
      
      // Update invoice to mark it as pending Klearstack processing
      const updated = {
        ...invoice,
        status: "Processing",
        klearstackDocumentId: null,
        klearstackStatus: 'pending_api_key',
      };
      
      await kv.set(`invoice:${id}`, updated);
      
      return c.json({ 
        success: true, 
        message: 'Invoice saved, pending Klearstack API configuration',
        data: updated
      });
    }
    
    try {
      // Upload to Klearstack API
      console.log(`📤 Uploading to Klearstack API: ${fileName}`);
      
      // Convert base64 to blob
      const fileBlob = fileData ? Uint8Array.from(atob(fileData.split(',')[1]), c => c.charCodeAt(0)) : null;
      
      if (!fileBlob) {
        throw new Error('No file data provided');
      }
      
      // Create form data for Klearstack
      const formData = new FormData();
      formData.append('file', new Blob([fileBlob]), fileName);
      formData.append('documentType', 'invoice');
      
      const uploadResponse = await fetch(`${klearstackApiUrl}/documents/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${klearstackApiKey}`,
        },
        body: formData,
      });
      
      if (!uploadResponse.ok) {
        throw new Error(`Klearstack API error: ${uploadResponse.statusText}`);
      }
      
      const uploadData = await uploadResponse.json();
      
      console.log(`✅ Uploaded to Klearstack. Document ID: ${uploadData.documentId}`);
      
      // Update invoice with Klearstack document ID
      const updated = {
        ...invoice,
        status: "Processing",
        klearstackDocumentId: uploadData.documentId,
        klearstackStatus: 'processing',
        lastUpdated: new Date().toISOString(),
      };
      
      await kv.set(`invoice:${id}`, updated);
      
      return c.json({ 
        success: true, 
        data: updated,
        klearstackDocumentId: uploadData.documentId
      });
      
    } catch (klearstackError) {
      console.error('❌ Klearstack API error:', klearstackError);
      
      // Update invoice status to failed
      const updated = {
        ...invoice,
        status: "Failed",
        klearstackError: String(klearstackError),
        lastUpdated: new Date().toISOString(),
      };
      
      await kv.set(`invoice:${id}`, updated);
      
      return c.json({ 
        success: false, 
        error: `Klearstack processing failed: ${klearstackError}`,
        data: updated
      }, 500);
    }
    
  } catch (error) {
    console.error("❌ Error processing invoice with Klearstack:", error);
    return c.json({ 
      success: false, 
      error: `Failed to process invoice: ${error}` 
    }, 500);
  }
}

// Get Klearstack extraction status
export async function getExtractionStatus(c: Context) {
  try {
    const id = c.req.param("id");
    console.log(`🔍 Checking Klearstack extraction status for invoice: ${id}`);
    
    // Get invoice from KV store
    const invoice = await kv.get(`invoice:${id}`);
    
    if (!invoice) {
      return c.json({ 
        success: false, 
        error: "Invoice not found" 
      }, 404);
    }
    
    if (!invoice.klearstackDocumentId) {
      return c.json({ 
        success: true, 
        status: 'not_started',
        message: 'Invoice not yet sent to Klearstack'
      });
    }
    
    // Get Klearstack API credentials
    const klearstackApiKey = Deno.env.get('KLEARSTACK_API_KEY');
    const klearstackApiUrl = Deno.env.get('KLEARSTACK_API_URL') || 'https://api.klearstack.com/v1';
    
    if (!klearstackApiKey) {
      return c.json({ 
        success: true, 
        status: 'pending_api_key',
        message: 'Waiting for Klearstack API configuration'
      });
    }
    
    try {
      // Check status with Klearstack
      const statusResponse = await fetch(
        `${klearstackApiUrl}/documents/${invoice.klearstackDocumentId}/status`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${klearstackApiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );
      
      if (!statusResponse.ok) {
        throw new Error(`Klearstack API error: ${statusResponse.statusText}`);
      }
      
      const statusData = await statusResponse.json();
      
      // If extraction is complete, update invoice with extracted data
      if (statusData.status === 'completed' && statusData.extractedData) {
        console.log(`✅ Extraction completed for invoice ${id}`);
        
        const updated = {
          ...invoice,
          ...statusData.extractedData,
          status: "Success",
          klearstackStatus: 'completed',
          dataFetchProgress: 100,
          isFetchingData: false,
          lastUpdated: new Date().toISOString(),
        };
        
        await kv.set(`invoice:${id}`, updated);
        
        return c.json({
          success: true,
          status: 'completed',
          progress: 100,
          data: updated
        });
      } else if (statusData.status === 'failed') {
        console.log(`❌ Extraction failed for invoice ${id}`);
        
        const updated = {
          ...invoice,
          status: "Failed",
          klearstackStatus: 'failed',
          klearstackError: statusData.error,
          lastUpdated: new Date().toISOString(),
        };
        
        await kv.set(`invoice:${id}`, updated);
        
        return c.json({
          success: true,
          status: 'failed',
          error: statusData.error,
          data: updated
        });
      } else {
        // Still processing
        console.log(`⏳ Still processing invoice ${id} (${statusData.progress}%)`);
        
        return c.json({
          success: true,
          status: 'processing',
          progress: statusData.progress || 0
        });
      }
      
    } catch (klearstackError) {
      console.error('❌ Error checking Klearstack status:', klearstackError);
      
      return c.json({
        success: false,
        error: `Failed to check Klearstack status: ${klearstackError}`
      }, 500);
    }
    
  } catch (error) {
    console.error("❌ Error getting extraction status:", error);
    return c.json({ 
      success: false, 
      error: `Failed to get extraction status: ${error}` 
    }, 500);
  }
}


