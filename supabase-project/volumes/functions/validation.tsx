/**
 * Validation API endpoints
 * Handles GST validation and QR code extraction
 */

import { Context } from "npm:hono";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

/**
 * Validate vendor GST status
 * GET /make-server-3c4ee602/validate/gst/:vendorName
 */
export async function validateGST(c: Context) {
  try {
    const vendorName = c.req.param("vendorName");

    // 🔍 CRITICAL DEBUG: Log what vendor name was received
    console.log("━".repeat(60));
    console.log("🔍 GST VALIDATION ENDPOINT CALLED");
    console.log(`   Raw vendorName parameter: "${vendorName}"`);
    console.log(`   Type: ${typeof vendorName}`);
    console.log(`   Is null: ${vendorName === null}`);
    console.log(`   Is undefined: ${vendorName === undefined}`);
    console.log(`   Is string "null": ${vendorName === "null"}`);
    console.log(`   Is string "undefined": ${vendorName === "undefined"}`);
    console.log(`   Is empty string: ${vendorName === ""}`);
    console.log(`   Length: ${vendorName?.length || 0}`);
    console.log("━".repeat(60));

    // Handle null, undefined, empty string, or the string "null"
    if (!vendorName || vendorName === "null" || vendorName === "undefined" || vendorName.trim() === "") {
      console.log("⚠️ GST Validation - No vendor name provided, skipping validation");
      return c.json(
        { 
          success: true,
          warning: "No vendor name provided - skipping GST validation",
          message: "Vendor name is required for GST validation",
          reason: "no_vendor_name",
          vendor: {
            name: null,
            id: null,
            gstin: null,
          },
          gstin_response: {
            status_code: 0,
            status: "Unknown",
            einvoiceStatus: "Unknown",
          },
        },
        200, // Return 200 to not block the flow
      );
    }

    console.log(
      `🔍 GST Validation - Fetching GSTIN for vendor: ${vendorName}`,
    );

    // Step 1: Fetch vendor GSTIN from vendor_master (get first match if multiple exist)
    const { data: vendors, error: vendorError } = await supabase
      .from("vendor_master")
      .select("gst_number, vendor_name, vendor_id")
      .eq("vendor_name", vendorName)
      .limit(1);

    if (vendorError || !vendors || vendors.length === 0) {
      console.error("❌ Vendor lookup failed");
      console.error(`   Vendor name searched: "${vendorName}"`);
      console.error(`   Database error:`, vendorError);
      console.error(`   Vendors found: ${vendors?.length || 0}`);
      
      // 🔍 DEBUG: Let's see what vendors actually exist
      const { data: allVendors } = await supabase
        .from("vendor_master")
        .select("vendor_name")
        .limit(10);
      console.error(`   Sample vendors in database:`, allVendors?.map(v => v.vendor_name).join(", "));
      
      // Return success with warning to not block the flow
      return c.json({
        success: true,
        warning: "Vendor not found in database - skipping GST validation",
        message: `Vendor '${vendorName}' not found in vendor master`,
        reason: "vendor_not_found",
        vendor: {
          name: vendorName,
          id: null,
          gstin: null,
        },
        gstin_response: {
          status_code: 0,
          status: "Unknown",
          einvoiceStatus: "Unknown",
        },
      }); // Return 200 to not block the flow
    }

    const vendor = vendors[0];

    if (!vendor.gst_number) {
      console.error(
        "❌ GSTIN not found for vendor:",
        vendorName,
      );
      // Return success with warning to not block the flow
      return c.json({
        success: true,
        warning: "Vendor has no GSTIN - skipping GST validation",
        message: `Vendor '${vendorName}' does not have a GSTIN`,
        reason: "missing_gstin",
        vendor: {
          name: vendor.vendor_name,
          id: vendor.vendor_id,
          gstin: null,
        },
        gstin_response: {
          status_code: 0,
          status: "Unknown",
          einvoiceStatus: "Unknown",
        },
      }); // Return 200 to not block the flow
    }

    const gstin = vendor.gst_number;
    console.log(`✅ Found GSTIN: ${gstin}`);

    // Step 2: Call GST Status API
    console.log(`🌐 Calling GST API for GSTIN: ${gstin}`);
    const gstApiUrl = `https://taxpayer.irisgst.com/api/search?gstin=${gstin}`;

    // Get API key from environment - with fallback logging
    const gstApiKey = Deno.env.get("GST_API_KEY");
    console.log(
      `🔑 GST_API_KEY status: ${gstApiKey ? "SET ✅" : "NOT SET ❌"}`,
    );

    if (!gstApiKey) {
      console.error(
        "❌ GST_API_KEY environment variable not set",
      );
      console.error(
        "📋 Available environment variables:",
        Object.keys(Deno.env.toObject()).filter(
          (k) => k.includes("GST") || k.includes("SUPABASE"),
        ),
      );

      // Return a non-blocking warning instead of failing validation
      return c.json(
        {
          success: true, // Changed to true to not block validation
          warning:
            "GST API key not configured - skipping GST validation",
          message:
            "GST validation skipped (API key not configured)",
          reason: "api_key_missing",
          vendor: {
            name: vendor.vendor_name,
            id: vendor.vendor_id,
            gstin: gstin,
          },
          gstin_response: {
            status_code: 0,
            status: "Unknown",
            einvoiceStatus: "Unknown",
            raw_response: { note: "API key not configured" },
          },
          should_extract_qr: false,
        },
        200,
      ); // Return 200 to not block the flow
    }

    const response = await fetch(gstApiUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        apikey: gstApiKey,
      },
    });

    if (!response.ok) {
      console.error(
        `❌ GST API error: ${response.status} ${response.statusText}`,
      );
      const errorText = await response.text();
      console.error(`   Error response: ${errorText}`);

      // Return success with warning to not block the flow
      return c.json({
        success: true,
        warning: "GST API returned error - skipping validation",
        message: `GST API error (${response.status}): ${response.statusText}`,
        reason: "gst_api_error",
        vendor: {
          name: vendor.vendor_name,
          id: vendor.vendor_id,
          gstin: gstin,
        },
        gstin_response: {
          status_code: 0,
          status: "Unknown",
          einvoiceStatus: "Unknown",
        },
      }); // Return 200 to not block the flow
    }

    // Parse JSON response with error handling
    let gstData;
    try {
      const responseText = await response.text();
      console.log(`📦 GST API raw response (first 200 chars): ${responseText.substring(0, 200)}`);
      gstData = JSON.parse(responseText);
    } catch (parseError: any) {
      console.error(`❌ GST API response parsing error:`, parseError.message);
      console.error(`   Response was not valid JSON. This usually means the GST API returned HTML or an error page.`);
      
      // Return success with warning to not block the flow
      return c.json({
        success: true,
        warning: "GST API returned invalid response - skipping validation",
        message: "Network error connecting to GST API.",
        reason: "network_error",
        vendor: {
          name: vendor.vendor_name,
          id: vendor.vendor_id,
          gstin: gstin,
        },
        gstin_response: {
          status_code: 0,
          status: "Unknown",
          einvoiceStatus: "Unknown",
        },
      }); // Return 200 to not block the flow
    }

    console.log(
      `✅ GST API Response:`,
      JSON.stringify(gstData, null, 2),
    );

    // Step 3: Validate GST status
    const statusCode = gstData.status_code;
    const status = gstData.status;
    const einvoiceStatus = gstData.einvoiceStatus;

    // Handle invalid GSTIN error
    if (statusCode === 0 && gstData.error) {
      console.error(`❌ Invalid GSTIN:`, gstData.error);
      return c.json(
        {
          success: false,
          error: "invalid_gstin",
          message: `Invalid GSTIN: ${gstData.error.message || "GSTIN format is invalid"}`,
          reason: "invalid_gstin",
          gstin_response: {
            status_code: statusCode,
            status: "Invalid",
            einvoiceStatus: "Unknown",
            raw_response: gstData,
          },
        },
        400,
      );
    }

    const isValid = statusCode === 1 && status === "Active";
    const isEInvoiceEnabled = einvoiceStatus === "Yes";

    console.log(`📊 GST Validation Result:`, {
      status_code: statusCode,
      status: status,
      einvoiceStatus: einvoiceStatus,
      isValid: isValid,
      isEInvoiceEnabled: isEInvoiceEnabled,
    });

    if (!isValid) {
      return c.json(
        {
          success: false,
          error: "gst_inactive",
          message: `GST status is ${status || "undefined"} (not Active)`,
          reason: "gst_inactive",
          gstin_response: {
            status_code: statusCode,
            status: status,
            einvoiceStatus: einvoiceStatus,
            raw_response: gstData,
          },
        },
        400,
      );
    }

    // Step 4: Return success response
    return c.json({
      success: true,
      message: "GST validation successful",
      vendor: {
        name: vendor.vendor_name,
        id: vendor.vendor_id,
        gstin: gstin,
      },
      gstin_response: {
        status_code: statusCode,
        status: status,
        einvoiceStatus: einvoiceStatus,
        raw_response: gstData,
      },
      should_extract_qr: isEInvoiceEnabled,
    });
  } catch (error: any) {
    console.error("❌ GST Validation error:", error);
    return c.json(
      {
        success: false,
        error: "validation_error",
        message: error.message,
      },
      500,
    );
  }
}

/**
 * Extract QR code data from invoice
 * POST /make-server-3c4ee602/validate/qr-extract
 * Body: { file_path: string, submission_id?: string }
 */
export async function extractQRCode(c: Context) {
  try {
    const body = await c.req.json();
    const { file_path, submission_id } = body;

    if (!file_path) {
      return c.json(
        { success: false, error: "file_path is required" },
        400,
      );
    }

    console.log(
      `🔍 QR Extraction - Processing file: ${file_path}`,
    );
    console.log(`📄 Submission ID: ${submission_id || "N/A"}`);

    // Step 1: Get signed URL for the file (if it's a storage path)
    let fileUrl = file_path;

    if (file_path.startsWith("make-3c4ee602/")) {
      console.log(`🔐 Getting signed URL for storage path...`);
      const bucketName = "make-3c4ee602";
      const filePath = file_path.replace("make-3c4ee602/", "");

      const { data: signedUrlData, error: signedUrlError } =
        await supabase.storage
          .from(bucketName)
          .createSignedUrl(filePath, 3600); // 1 hour expiry

      if (signedUrlError || !signedUrlData) {
        console.error(
          "❌ Failed to get signed URL:",
          signedUrlError,
        );
        return c.json(
          {
            success: false,
            error: "signed_url_error",
            message: "Failed to generate signed URL for file",
          },
          500,
        );
      }

      fileUrl = signedUrlData.signedUrl;
      console.log(`✅ Generated signed URL`);
    }

    // Step 2: Call QR Extraction API
    console.log(`🌐 Calling QR Extraction API...`);
    const qrApiUrl =
      "https://dentsudev.dmacq.app/api/invoices/extract-qr-from-path";

    // Add timeout to prevent hanging - increased from 10s to 30s for better success rate
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    try {
      const response = await fetch(qrApiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI5ZWY0NTk5My01NGNkLTQzZDgtYmIzNS00NGVkNmQ1NTAzZTkiLCJqdGkiOiJiNjg0ZDg5YTZhYjgyNDM5Y2ZhYjQ2YzA5NzJkM2U2MWUwOGI2NjQ2YzNjYWY2ZDNkMDc0NDBlZTdhMDQ0NmI5Zjk0NWRjYTQ2YWU0MGM1MyIsImlhdCI6MTc2MDM1NjI0My43NzMxNjksIm5iZiI6MTc2MDM1NjI0My43NzMxNzYsImV4cCI6MTc5MTg5MjI0My43NDk1NjIsInN1YiI6Ijk4NjRkYTRlLTRhODctNDA4Yi1iMzljLWU2MzhhN2E4NmIxNCIsInNjb3BlcyI6W119.HLWG16P6o3OvgWFl_eoKRnzt0grY9I0tysUMizR-NbWmYCvXh7HWF30j1DzM5hCKkUB-Np_B1PZc7PELTVok16skiZJAWai5U4VJ8g9ZW15_W-vNYcH2nzeg4wwsBRD8CRGaa0k9ug9-n1f1lA4KmJldkK8gZEJvJIgS7R5HPzEOfmMPikr6lh2Z46BO6NHBeTG-r5b1crwnJqAZYyWCK3K0F2q6o9jAk4LyptUiDwuiBs4s1oE_5v9JUuDebuMioeHl5aBNFgD2l5Qq2spsK5QBsnhrKfC9lFgHN_60g3isCuS-9kO4xvcdDYZnRBW1CCuIHzhM5QTaxN0g13GQ7UgMuF-Cj3SA_9zph8yKtEyDw4OiIWdjknr-89p0YQ15cz6KMs73br1Hz1M67p6UFb9t0ianhdDHYcK0DHcXR7jGu9aBJoQ2mNOnL4hlHn6B9owJZlgz_1CCtPG4fo7Wlo0IvBJyTvUgfN5OxPnbX7D5Lwfml5-MyWQdE4mYGH_SSvgryes_zJOTik4Q0G8A6JK594Rv_Zi6n5591OBZ_HzGACe_lebT9M2mcbTlB3syjL1Fo2zeyYKRtVJKaeM28ktxCQjOal9HxGxhL1b7P_QByo_kFWqhuX8IZ8OEUfmewnbh855QBkqkaS1UICsPUEoZUPZu61KGy7MJMrOxixM`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_path: fileUrl }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseText = await response.text();
      console.log(
        `📡 QR API Response Status: ${response.status}`,
      );
      console.log(`📡 QR API Response Body:`, responseText);

      if (!response.ok) {
        console.error(`❌ QR API error: ${response.status}`);
        // Non-blocking error - return success with qr_not_available flag
        console.log(`⚠️ QR extraction failed, continuing without QR data (non-blocking)`);
        return c.json(
          {
            success: true, // Changed to true - QR extraction is optional
            status: true,
            qr_available: false,
            qr_skipped: true,
            message: "QR extraction service unavailable - continued without QR data",
            error: "qr_api_error",
          },
          200,
        );
      }

      // Step 3: Parse response
      let qrData;
      try {
        qrData = JSON.parse(responseText);
      } catch (parseError) {
        console.error(
          `❌ Failed to parse QR response:`,
          parseError,
        );
        // Non-blocking error - return success with qr_not_available flag
        console.log(`⚠️ QR parsing failed, continuing without QR data (non-blocking)`);
        return c.json(
          {
            success: true, // Changed to true - QR extraction is optional
            status: true,
            qr_available: false,
            qr_skipped: true,
            message: "QR data parsing failed - continued without QR data",
            error: "parse_error",
          },
          200,
        );
      }

      // Step 4: Check QR extraction status
      if (!qrData.status || qrData.status === false) {
        console.log(`⚠️ QR not found in invoice, continuing without QR data (non-blocking)`);
        return c.json({
          success: true, // Changed to true - QR extraction is optional
          status: true,
          qr_available: false,
          qr_found: false,
          message: "No QR code found in invoice - continued without QR data",
          raw_response: qrData,
        });
      }

      // Step 5: Return successful QR extraction
      console.log(`✅ QR code extracted successfully`);
      return c.json({
        success: true,
        status: true,
        qr_available: true,
        qr_found: true,
        message: "QR code extracted successfully",
        qr_data: qrData,
      });
    } catch (error: any) {
      clearTimeout(timeoutId);
      
      // Handle timeout and connection errors gracefully
      if (error.name === 'AbortError' || error.code === 'ETIMEDOUT') {
        console.log(`⚠️ QR Extraction error (non-blocking): ${error.message || 'Timeout'}`);
        return c.json({
          success: true, // Changed to true - QR extraction is optional
          status: true,
          qr_available: false,
          qr_skipped: true,
          timeout: true,
          message: "QR extraction service timed out - continued without QR data",
          error: "timeout",
        });
      }
      
      // Other network errors
      console.log(`⚠️ QR Extraction error (non-blocking): ${error.message}`);
      return c.json({
        success: true, // Changed to true - QR extraction is optional
        status: true,
        qr_available: false,
        qr_skipped: true,
        message: "QR extraction service unavailable - continued without QR data",
        error: error.message,
      });
    }
  } catch (error: any) {
    console.error(
      "⚠️ QR Extraction error (non-blocking):",
      error,
    );
    return c.json(
      {
        success: false,
        status: false,
        error: "extraction_error",
        message: `QR extraction failed: ${error.message || "Unknown error"}. This is non-blocking.`,
      },
      200,
    ); // Return 200 to not block validation flow
  }
}

/**
 * Retry QR extraction with exponential backoff
 * POST /make-server-3c4ee602/validate/qr-retry
 * Body: { file_path: string, submission_id: string, retry_count: number }
 */
export async function retryQRExtraction(c: Context) {
  try {
    const body = await c.req.json();
    const { file_path, submission_id, retry_count = 0 } = body;

    if (!file_path || !submission_id) {
      return c.json(
        {
          success: false,
          error: "file_path and submission_id are required",
        },
        400,
      );
    }

    const maxRetries = 2;
    if (retry_count >= maxRetries) {
      console.error(
        `❌ Max retries (${maxRetries}) reached for submission ${submission_id}`,
      );
      return c.json(
        {
          success: false,
          error: "max_retries_reached",
          message: `Failed after ${maxRetries} retries`,
          retry_count: retry_count,
        },
        400,
      );
    }

    // Calculate backoff delay: 500ms, 1s, 2s
    const backoffDelays = [500, 1000, 2000];
    const delay = backoffDelays[retry_count] || 2000;

    console.log(
      `🔄 Retry ${retry_count + 1}/${maxRetries} for submission ${submission_id} (waiting ${delay}ms)`,
    );

    // Wait for backoff
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Call extraction endpoint
    return extractQRCode(c);
  } catch (error: any) {
    console.error("❌ QR Retry error:", error);
    return c.json(
      {
        success: false,
        error: "retry_error",
        message: error.message,
      },
      500,
    );
  }
}

/**
 * Helper function to format QR date
 * Converts "2024-07-08 17:29:00" to "08 Jul 2024"
 */
function formatQRDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const day = date.getDate().toString().padStart(2, "0");
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
  } catch (error) {
    console.error("❌ Error formatting date:", error);
    return dateStr; // Return original if parsing fails
  }
}
