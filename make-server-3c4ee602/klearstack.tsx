import { Hono } from "npm:hono";
import { createClient } from "jsr:@supabase/supabase-js@2";

const app = new Hono();

// ============================================================================
// KLEARSTACK API CONFIGURATION
// ============================================================================

const KLEARSTACK_API_URL = Deno.env.get('KLEARSTACK_API_URL') || 'https://staging.klearstackapp.com/api';
const KLEARSTACK_USERNAME = Deno.env.get('KLEARSTACK_USERNAME') || '';
const KLEARSTACK_PASSWORD = Deno.env.get('KLEARSTACK_PASSWORD') || '';
const KLEARSTACK_COMPANY_NAME = Deno.env.get('KLEARSTACK_COMPANY_NAME') || '';

// ============================================================================
// SUPABASE CLIENT
// ============================================================================
function getSupabaseClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
}

// ============================================================================
// CUSTOM KV STORE (for submission metadata only)
// ============================================================================
const KV_TABLE_NAME = 'kv_store_3c4ee602';

const customKV = {
  async set(key: string, value: any): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from(KV_TABLE_NAME)
      .upsert({ key, value });
    
    if (error) throw new Error(`KV set error: ${error.message}`);
  },

  async get(key: string): Promise<any> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from(KV_TABLE_NAME)
      .select('value')
      .eq('key', key)
      .maybeSingle();
    
    if (error) throw new Error(`KV get error: ${error.message}`);
    return data?.value;
  },
};

// ============================================================================
// SAFE JSON PARSING UTILITY
// ============================================================================
function safeParseJSON(responseText: string): any {
  let cleanText = responseText.trim();
  
  const braceIndex = cleanText.indexOf('{');
  const bracketIndex = cleanText.indexOf('[');
  
  if (braceIndex === -1 && bracketIndex === -1) {
    throw new Error(`No JSON found in response: ${responseText.substring(0, 200)}`);
  }
  
  const jsonStart = braceIndex !== -1 && (bracketIndex === -1 || braceIndex < bracketIndex) 
    ? braceIndex 
    : bracketIndex;
  
  cleanText = cleanText.substring(jsonStart);
  
  const startChar = cleanText[0];
  const endChar = startChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  
  for (let i = 0; i < cleanText.length; i++) {
    const char = cleanText[i];
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === startChar) {
        depth++;
      } else if (char === endChar) {
        depth--;
        if (depth === 0) {
          cleanText = cleanText.substring(0, i + 1);
          break;
        }
      }
    }
  }
  
  return JSON.parse(cleanText);
}

// ============================================================================
// HELPER: Store API Response in klear_responses table
// ============================================================================
async function storeApiResponse(
  submissionId: string,
  step: string,
  requestPayload: any,
  responsePayload: any,
  statusCode: number,
  errorMessage: string | null = null
) {
  const supabase = getSupabaseClient();
  
  const { error } = await supabase
    .from('klear_responses')
    .insert({
      submission_id: submissionId,
      step,
      request_payload: requestPayload,
      response_payload: responsePayload,
      status_code: statusCode,
      error_message: errorMessage,
    });
  
  if (error) {
    // Don't throw - storing audit logs shouldn't break the main flow
    // But we'll track it for debugging
    return { success: false, error: error.message };
  }
  
  return { success: true };
}

// ============================================================================
// HELPER: Store Tokens in klear_tokens table
// ============================================================================
async function storeTokens(
  submissionId: string,
  accessToken: string,
  refreshToken: string,
  uploaderId: string = '00000000-0000-0000-0000-000000000000'
) {
  const supabase = getSupabaseClient();
  
  // Calculate expiration (KlearStack tokens typically expire in 1 hour)
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 1);
  
  const { error } = await supabase
    .from('klear_tokens')
    .insert({
      uploader_id: uploaderId,
      submission_id: submissionId,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt.toISOString(),
    });
  
  if (error) {
    // Don't throw - storing tokens shouldn't break the main flow
    // But we'll track it for debugging
    return { success: false, error: error.message };
  }
  
  return { success: true };
}

// ============================================================================
// STEP 1: CREATE SUBMISSION RECORD
// ============================================================================
app.post('/create-submission', async (c) => {
  console.log('🔵 [Server] /create-submission called');
  
  try {
    const body = await c.req.json();
    const { submissionId, fileName, filePath, vendorName, poRoNumber, docType } = body;

    console.log('📝 [Server] Creating submission:', { submissionId, fileName, filePath });

    const submissionData = {
      id: submissionId,
      file_name: fileName,
      main_file_path: filePath,
      vendor_name: vendorName || 'Unknown Vendor',
      po_ro_number: poRoNumber || null,
      doc_type: docType || 'Invoice',
      status: 'pending',
      progress: 0,
      created_at: new Date().toISOString(),
    };

    // Store in KV for submission tracking
    console.log('�� [Server] Storing in KV...');
    await customKV.set(`submission:${submissionId}`, submissionData);
    console.log('✅ [Server] KV store complete');

    // ❌ REMOVED: Server should NOT create invoice record here
    // The invoice will be created AFTER KlearStack extraction completes
    // by the frontend's transferToInvoicesWithKlearStack() function
    // 
    // This prevents duplicate invoice records from being created
    console.log('📋 [Server] Skipping invoice table insert (will be created after extraction)');

    return c.json({
      success: true,
      submissionId,
      message: 'Submission created successfully',
    });
  } catch (error: any) {
    console.error('❌ [Server] create-submission error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// ============================================================================
// STEP 2: UPLOAD INVOICE (includes Steps 1, 2, 3 from Postman)
// ============================================================================
app.post('/make-server-3c4ee602/klearstack/upload-invoice', async (c) => {
  console.log('🔵 [Server] /upload-invoice called');
  
  try {
    const body = await c.req.json();
    const { submissionId, filePath, fileName } = body;
    
    console.log('📝 [Server] Upload params:', { submissionId, filePath, fileName });

    // ========================================================================
    // STEP 1: Get initial access token
    // ========================================================================
    console.log('🔑 [Server] Step 1: Getting access token...');
    const tokenUrl = 'https://staging.klearstackapp.com/access/klearstack/get_access_token';
    
    const tokenFormData = new FormData();
    tokenFormData.append('username', KLEARSTACK_USERNAME);
    tokenFormData.append('password', KLEARSTACK_PASSWORD);
    tokenFormData.append('company_name', KLEARSTACK_COMPANY_NAME);

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      body: tokenFormData,
    });

    const tokenText = await tokenResponse.text();
    
    if (!tokenResponse.ok) {
      await storeApiResponse(
        submissionId,
        'step1_token',
        { username: KLEARSTACK_USERNAME, company_name: KLEARSTACK_COMPANY_NAME },
        { error: tokenText },
        tokenResponse.status,
        `Failed to get access token: ${tokenResponse.status}`
      );
      return c.json({ error: `Failed to get access token: ${tokenText}` }, tokenResponse.status);
    }

    const tokenData = safeParseJSON(tokenText);
    const initialAccessToken = tokenData.access_token;
    const initialRefreshToken = tokenData.refresh_token;

    if (!initialAccessToken || !initialRefreshToken) {
      return c.json({ error: 'No access/refresh token in Step 1 response' }, 500);
    }

    // Store Step 1 response
    const step1ResponseResult = await storeApiResponse(
      submissionId,
      'step1_token',
      { username: KLEARSTACK_USERNAME, company_name: KLEARSTACK_COMPANY_NAME },
      tokenData,
      tokenResponse.status
    );

    // Store tokens in klear_tokens table
    const storeTokensResult = await storeTokens(submissionId, initialAccessToken, initialRefreshToken);

    // Track storage errors for debugging (don't fail the main flow)
    const storageErrors: string[] = [];
    if (!step1ResponseResult.success) {
      storageErrors.push(`Step1 response storage: ${step1ResponseResult.error}`);
    }
    if (!storeTokensResult.success) {
      storageErrors.push(`Token storage: ${storeTokensResult.error}`);
    }

    // ========================================================================
    // STEP 2: Refresh the token to get NEW access token
    // ========================================================================
    console.log('🔑 [Server] Step 2: Refreshing access token...');
    const refreshUrl = 'https://staging.klearstackapp.com/access/klearstack/getaccesstokenfromrefreshtoken';
    
    const refreshFormData = new FormData();
    refreshFormData.append('refresh_token', initialRefreshToken);
    refreshFormData.append('company_name', KLEARSTACK_COMPANY_NAME);

    const refreshResponse = await fetch(refreshUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${initialAccessToken}`,
      },
      body: refreshFormData,
    });

    const refreshText = await refreshResponse.text();
    
    if (!refreshResponse.ok) {
      await storeApiResponse(
        submissionId,
        'step2_refresh',
        { refresh_token: '***', company_name: KLEARSTACK_COMPANY_NAME },
        { error: refreshText },
        refreshResponse.status,
        `Failed to refresh token: ${refreshResponse.status}`
      );
      return c.json({ error: `Failed to refresh token: ${refreshText}` }, refreshResponse.status);
    }

    const refreshData = safeParseJSON(refreshText);
    const newAccessToken = refreshData.access_token;
    const newRefreshToken = refreshData.refresh_token;

    if (!newAccessToken) {
      return c.json({ error: 'No access token in Step 2 refresh response' }, 500);
    }

    // Store Step 2 response
    await storeApiResponse(
      submissionId,
      'step2_refresh',
      { refresh_token: '***', company_name: KLEARSTACK_COMPANY_NAME },
      refreshData,
      refreshResponse.status
    );

    // Update tokens in klear_tokens table with refreshed tokens
    await storeTokens(submissionId, newAccessToken, newRefreshToken);

    // ========================================================================
    // STEP 3: Download file from Supabase Storage
    // ========================================================================
    const supabase = getSupabaseClient();

    const { data: fileData, error: downloadError } = await supabase.storage
      .from('make-3c4ee602-invoices')
      .download(filePath);

    if (downloadError || !fileData) {
      return c.json({ 
        error: 'Failed to download file from storage',
        details: downloadError?.message,
        filePath: filePath
      }, 500);
    }

    const arrayBuffer = await fileData.arrayBuffer();

    // ========================================================================
    // STEP 3: Upload with NEW ACCESS TOKEN from Step 2
    // ========================================================================
    console.log('🔑 [Server] Step 3: Uploading file...');
    const uploadUrl = 'https://staging.klearstackapp.com/access/klearstack/processdocument';
    
    const formData = new FormData();
    formData.append('file', new Blob([arrayBuffer], { type: 'application/pdf' }), fileName);
    formData.append('company_name', KLEARSTACK_COMPANY_NAME);
    formData.append('username', KLEARSTACK_USERNAME);
    formData.append('password', KLEARSTACK_PASSWORD);
    formData.append('document_type', 'Invoices');
    formData.append('processing_pref', 'Accuracy');
    formData.append('verify', 'False');

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${newAccessToken}`,
      },
      body: formData,
    });

    const uploadResponseText = await uploadResponse.text();

    if (!uploadResponse.ok) {
      await storeApiResponse(
        submissionId,
        'step3_upload',
        { 
          filename: fileName, 
          company_name: KLEARSTACK_COMPANY_NAME,
          document_type: 'Invoices',
          processing_pref: 'Accuracy'
        },
        { error: uploadResponseText },
        uploadResponse.status,
        `KlearStack upload failed: ${uploadResponse.status}`
      );
      
      return c.json({ 
        error: `KlearStack upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
        body: uploadResponseText,
        url: uploadUrl
      }, uploadResponse.status);
    }

    // Parse response
    const uploadData = safeParseJSON(uploadResponseText);

    // Validate OCR reference is present - KlearStack returns OCR_ref_no, not OCR_ext_no
    const batchId = uploadData.OCR_ref_no || uploadData.OCR_ext_no || uploadData.batch_id;
    
    if (!batchId) {
      return c.json({
        error: 'Upload succeeded but no batch ID was returned from KlearStack',
        response: uploadData
      }, 500);
    }

    // Store Step 3 response in klear_responses table
    await storeApiResponse(
      submissionId,
      'step3_upload',
      { 
        filename: fileName, 
        company_name: KLEARSTACK_COMPANY_NAME,
        document_type: 'Invoices',
        processing_pref: 'Accuracy'
      },
      uploadData,
      uploadResponse.status
    );

    // Store OCR reference for polling
    await customKV.set(`klearstack_batch:${submissionId}`, {
      batch_id: batchId,
      ocr_ref_no: uploadData.OCR_ref_no,
      ocr_ext_no: uploadData.OCR_ext_no,
      status: uploadData.status,
      file_name: fileName,
      uploaded_at: new Date().toISOString(),
    });

    // ========================================================================
    // RETURN IMMEDIATELY - Let client poll separately to avoid timeout
    // ========================================================================
    // Supabase has a 10-second limit, and we've already used 3-4 seconds
    // for token + refresh + upload. Polling would push us over the limit.
    console.log('✅ [Server] Upload successful, returning batch ID for client to poll');
    
    return c.json({
      success: true,
      ocrExtNo: batchId,
      batchId: batchId,
      status: 'processing',
      message: 'Upload successful, data extraction in progress',
    });
    
  } catch (error: any) {
    return c.json({ 
      error: `Upload exception: ${error.message}`,
      stack: error.stack
    }, 500);
  }
});

// ============================================================================
// STEP 3: POLL STATUS (includes Steps 1, 2, 4 from Postman)
// ============================================================================
app.post('/make-server-3c4ee602/klearstack/poll-status', async (c) => {
  try {
    const body = await c.req.json();
    const { submissionId, batchId } = body;

    // Validate required parameters
    if (!submissionId || !batchId) {
      return c.json({ 
        error: 'Missing required parameters',
        details: {
          submissionId: submissionId || 'missing',
          batchId: batchId || 'missing',
        }
      }, 400);
    }

    // ========================================================================
    // STEP 1: Get initial access token
    // ========================================================================
    const tokenUrl = 'https://staging.klearstackapp.com/access/klearstack/get_access_token';
    
    const tokenFormData = new FormData();
    tokenFormData.append('username', KLEARSTACK_USERNAME);
    tokenFormData.append('password', KLEARSTACK_PASSWORD);
    tokenFormData.append('company_name', KLEARSTACK_COMPANY_NAME);

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      body: tokenFormData,
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return c.json({ error: `Failed to get access token: ${errorText}` }, tokenResponse.status);
    }

    const tokenText = await tokenResponse.text();
    const tokenData = safeParseJSON(tokenText);
    const initialAccessToken = tokenData.access_token;
    const initialRefreshToken = tokenData.refresh_token;

    if (!initialAccessToken || !initialRefreshToken) {
      return c.json({ error: 'No access/refresh token in Step 1 response' }, 500);
    }

    // ========================================================================
    // STEP 2: Refresh the token to get NEW access token
    // ========================================================================
    const refreshUrl = 'https://staging.klearstackapp.com/access/klearstack/getaccesstokenfromrefreshtoken';
    
    const refreshFormData = new FormData();
    refreshFormData.append('refresh_token', initialRefreshToken);
    refreshFormData.append('company_name', KLEARSTACK_COMPANY_NAME);

    const refreshResponse = await fetch(refreshUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${initialAccessToken}`,
      },
      body: refreshFormData,
    });

    if (!refreshResponse.ok) {
      const errorText = await refreshResponse.text();
      return c.json({ error: `Failed to refresh token: ${errorText}` }, refreshResponse.status);
    }

    const refreshText = await refreshResponse.text();
    const refreshData = safeParseJSON(refreshText);
    const newAccessToken = refreshData.access_token;

    if (!newAccessToken) {
      return c.json({ error: 'No access token in Step 2 refresh response' }, 500);
    }

    // ========================================================================
    // STEP 4: Poll status with exact Postman configuration
    // ========================================================================
    const statusUrl = 'https://staging.klearstackapp.com/access/klearstack/getbatchdocuments';

    // Validate that all credentials are available
    if (!KLEARSTACK_COMPANY_NAME || !KLEARSTACK_USERNAME || !KLEARSTACK_PASSWORD) {
      return c.json({ error: 'Missing KlearStack credentials' }, 500);
    }

    // According to Postman screenshot, Step 4 uses:
    // - company_name, username, password
    // - document_type: "Invoices"  
    // - batch_id: <OCR_ref_no from Step 3>
    
    const formData = new FormData();
    formData.append('company_name', KLEARSTACK_COMPANY_NAME);
    formData.append('username', KLEARSTACK_USERNAME);
    formData.append('password', KLEARSTACK_PASSWORD);
    formData.append('document_type', 'Invoices');
    formData.append('batch_id', batchId); // This is the OCR_ref_no from Step 3

    const response = await fetch(statusUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${newAccessToken}`, // Use fresh token from Step 2
      },
      body: formData,
    });

    const responseText = await response.text();
    
    if (!response.ok) {
      await storeApiResponse(
        submissionId,
        'step4_batch',
        { 
          company_name: KLEARSTACK_COMPANY_NAME,
          username: KLEARSTACK_USERNAME,
          document_type: 'Invoices',
          batch_id: batchId
        },
        { error: responseText },
        response.status,
        `KlearStack getBatchDocuments error: ${response.status}`
      );
      
      return c.json({ error: `KlearStack status error: ${response.status} ${responseText}` }, response.status);
    }

    const data = safeParseJSON(responseText);

    // Store Step 4 response
    await storeApiResponse(
      submissionId,
      'step4_batch',
      { 
        company_name: KLEARSTACK_COMPANY_NAME,
        username: KLEARSTACK_USERNAME,
        document_type: 'Invoices',
        batch_id: batchId
      },
      data,
      response.status
    );

    // Store extracted data if available
    if (data.results && data.results.length > 0) {
      await customKV.set(`klearstack_extracted:${submissionId}`, {
        extracted_at: new Date().toISOString(),
        batch_id: batchId,
        full_response: data,
        document_data: data.results[0],
      });
    }

    // Check extraction status - handle multiple possible field names and values
    const extractionStatus = data.extraction_status || data.status || data.extractionStatus || '';
    const isCompleted = extractionStatus.toLowerCase() === 'completed' || extractionStatus.toLowerCase() === 'complete';
    const isFailed = extractionStatus.toLowerCase() === 'failed' || extractionStatus.toLowerCase() === 'error';
    const isProcessing = extractionStatus.toLowerCase() === 'processing' || extractionStatus.toLowerCase() === 'in progress' || extractionStatus.toLowerCase() === 'pending';

    if (isCompleted) {
      // Extract data from either results array or extracted_data field
      const extractedData = data.results || data.extracted_data || data.data || data;
      
      return c.json({
        success: true,
        status: 'complete',
        progress: 100,
        data: extractedData,
      });
    } else if (isFailed) {
      return c.json({
        success: false,
        status: 'failed',
        error: data.error || data.message || 'Extraction failed',
      });
    } else if (isProcessing) {
      return c.json({
        success: true,
        status: 'processing',
        progress: 50,
        extraction_status: extractionStatus,
      });
    } else {
      // Unknown status - return raw response for debugging
      return c.json({
        success: true,
        status: 'processing',
        progress: 25,
        extraction_status: extractionStatus,
        raw_response: data,
        debug_note: 'Unknown extraction_status value, treating as processing'
      });
    }
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// ============================================================================
// STEP 4: POLL COMPLETION (polls repeatedly until complete or timeout)
// ============================================================================
app.post('/poll-completion', async (c) => {
  console.log('🔵 [Server] /poll-completion called');
  
  try {
    const body = await c.req.json();
    const { submissionId, batchId, maxDuration = 300000 } = body; // Default 5 minutes

    console.log('📝 [Server] Poll params:', { submissionId, batchId, maxDuration });

    // Validate required parameters
    if (!submissionId || !batchId) {
      return c.json({ 
        error: 'Missing required parameters',
        details: {
          submissionId: submissionId || 'missing',
          batchId: batchId || 'missing',
        }
      }, 400);
    }

    const startTime = Date.now();
    const pollInterval = 5000; // Poll every 5 seconds
    let attempts = 0;
    const maxAttempts = Math.floor(maxDuration / pollInterval);

    console.log(`🔄 [Server] Starting polling (max ${maxAttempts} attempts)...`);

    while (Date.now() - startTime < maxDuration) {
      attempts++;
      console.log(`🔍 [Server] Polling attempt ${attempts}/${maxAttempts}...`);

      try {
        // ========================================================================
        // Get fresh tokens for this poll attempt
        // ========================================================================
        const tokenUrl = 'https://staging.klearstackapp.com/access/klearstack/get_access_token';
        
        const tokenFormData = new FormData();
        tokenFormData.append('username', KLEARSTACK_USERNAME);
        tokenFormData.append('password', KLEARSTACK_PASSWORD);
        tokenFormData.append('company_name', KLEARSTACK_COMPANY_NAME);

        const tokenResponse = await fetch(tokenUrl, {
          method: 'POST',
          body: tokenFormData,
        });

        if (!tokenResponse.ok) {
          console.error(`❌ [Server] Token fetch failed: ${tokenResponse.status}`);
          // Don't fail immediately, wait and retry
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }

        const tokenText = await tokenResponse.text();
        const tokenData = safeParseJSON(tokenText);
        const initialAccessToken = tokenData.access_token;
        const initialRefreshToken = tokenData.refresh_token;

        // Refresh token
        const refreshUrl = 'https://staging.klearstackapp.com/access/klearstack/getaccesstokenfromrefreshtoken';
        
        const refreshFormData = new FormData();
        refreshFormData.append('refresh_token', initialRefreshToken);
        refreshFormData.append('company_name', KLEARSTACK_COMPANY_NAME);

        const refreshResponse = await fetch(refreshUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${initialAccessToken}`,
          },
          body: refreshFormData,
        });

        if (!refreshResponse.ok) {
          console.error(`❌ [Server] Token refresh failed: ${refreshResponse.status}`);
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }

        const refreshText = await refreshResponse.text();
        const refreshData = safeParseJSON(refreshText);
        const newAccessToken = refreshData.access_token;

        // ========================================================================
        // Poll KlearStack status
        // ========================================================================
        const statusUrl = 'https://staging.klearstackapp.com/access/klearstack/getbatchdocuments';
        
        const formData = new FormData();
        formData.append('company_name', KLEARSTACK_COMPANY_NAME);
        formData.append('username', KLEARSTACK_USERNAME);
        formData.append('password', KLEARSTACK_PASSWORD);
        formData.append('document_type', 'Invoices');
        formData.append('batch_id', batchId);

        const response = await fetch(statusUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${newAccessToken}`,
          },
          body: formData,
        });

        const responseText = await response.text();
        
        if (!response.ok) {
          console.error(`❌ [Server] Status check failed: ${response.status}`);
          await storeApiResponse(
            submissionId,
            'step4_batch',
            { 
              company_name: KLEARSTACK_COMPANY_NAME,
              username: KLEARSTACK_USERNAME,
              document_type: 'Invoices',
              batch_id: batchId,
              attempt: attempts
            },
            { error: responseText },
            response.status,
            `Poll attempt ${attempts} failed: ${response.status}`
          );
          
          // Wait and retry
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }

        const data = safeParseJSON(responseText);

        // Store response
        await storeApiResponse(
          submissionId,
          'step4_batch',
          { 
            company_name: KLEARSTACK_COMPANY_NAME,
            username: KLEARSTACK_USERNAME,
            document_type: 'Invoices',
            batch_id: batchId,
            attempt: attempts
          },
          data,
          response.status
        );

        // Check extraction status
        const extractionStatus = data.extraction_status || data.status || data.extractionStatus || '';
        const isCompleted = extractionStatus.toLowerCase() === 'completed' || extractionStatus.toLowerCase() === 'complete';
        const isFailed = extractionStatus.toLowerCase() === 'failed' || extractionStatus.toLowerCase() === 'error';

        console.log(`📊 [Server] Status: ${extractionStatus} (attempt ${attempts})`);

        if (isCompleted) {
          console.log(`✅ [Server] Extraction complete!`);
          
          // Store extracted data
          if (data.results && data.results.length > 0) {
            await customKV.set(`klearstack_extracted:${submissionId}`, {
              extracted_at: new Date().toISOString(),
              batch_id: batchId,
              full_response: data,
              document_data: data.results[0],
            });
          }

          const extractedData = data.results || data.extracted_data || data.data || data;
          
          return c.json({
            success: true,
            status: 'complete',
            progress: 100,
            data: extractedData,
            attempts,
          });
        } else if (isFailed) {
          console.log(`❌ [Server] Extraction failed!`);
          return c.json({
            success: false,
            status: 'failed',
            error: data.error || data.message || 'Extraction failed',
            attempts,
          });
        } else {
          // Still processing - wait and retry
          console.log(`⏳ [Server] Still processing... waiting ${pollInterval}ms`);
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
      } catch (pollError: any) {
        console.error(`❌ [Server] Poll attempt ${attempts} error:`, pollError.message);
        // Wait and retry
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    // Timeout reached
    console.log(`⏰ [Server] Polling timeout after ${attempts} attempts`);
    return c.json({
      success: false,
      status: 'timeout',
      error: 'KlearStack extraction timeout - processing is taking longer than expected',
      attempts,
      duration: Date.now() - startTime,
    });

  } catch (error: any) {
    console.error('❌ [Server] poll-completion error:', error);
    return c.json({ error: error.message }, 500);
  }
});

export default app;
