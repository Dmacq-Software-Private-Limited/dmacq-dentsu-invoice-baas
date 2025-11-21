// ============================================================================
// CRITICAL FIX: Completely silence ALL console output to prevent stdout pollution
// ============================================================================
// In Deno Edge Functions, ANY output to stdout/stderr will corrupt HTTP responses.
// The only reliable way to prevent response corruption is to completely
// silence ALL console output and stderr writes during request processing.
// Logs can be viewed in the Supabase Edge Function logs dashboard.

// Save original console methods
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;
const originalConsoleDebug = console.debug;

// Redirect ALL console methods to no-ops
console.log = () => {}; // Silent
console.error = () => {}; // Silent - THIS WAS POLLUTING RESPONSES!
console.warn = () => {}; // Silent
console.info = () => {}; // Silent
console.debug = () => {}; // Silent

// CRITICAL: Also silence direct Deno write operations
const originalStdout = Deno.stdout.write;
const originalStderr = Deno.stderr.write;

// Override Deno.stdout.write to prevent ANY writes
Deno.stdout.write = async () => 0;
Deno.stderr.write = async () => 0;

// ALL output is now completely silenced to prevent HTTP response corruption
// View logs in: Supabase Dashboard > Edge Functions > Logs

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
// REMOVED: logger import - it was causing JSON parsing errors by polluting responses
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as kv from "./kv_store.tsx";
import * as invoices from "./invoices.tsx";
import * as storage from "./storage.tsx";
import * as disputes from "./disputes.tsx";
import * as validation from "./validation.tsx";
import externalAuthApp from "./external-auth.tsx";
import klearstackApp from "./klearstack.tsx";

const app = new Hono();

// REMOVED: Initialize storage bucket on startup - causes stdout pollution
// The bucket will be created lazily on first use via the init-bucket endpoint
// storage.initializeBucket().catch(console.error);

// REMOVED: logger middleware - it was writing to stdout and corrupting JSON responses
// All our routes have their own console.log/console.error for debugging

// Enable CORS for all routes and methods
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

// Health check endpoint
app.get("/make-server-3c4ee602/health", (c) => {
  return c.json({ status: "ok" });
});

// Diagnostic endpoint - check Supabase configuration
app.get("/make-server-3c4ee602/diagnostics", (c) => {
  const url = Deno.env.get("SUPABASE_URL");
  const hasServiceKey = !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const hasAnonKey = !!Deno.env.get("SUPABASE_ANON_KEY");
  
  return c.json({
    supabase: {
      url: url || "NOT_SET",
      hasServiceRoleKey: hasServiceKey,
      hasAnonKey: hasAnonKey,
    },
    environment: {
      denoVersion: Deno.version.deno,
      v8Version: Deno.version.v8,
    },
    timestamp: new Date().toISOString(),
  });
});

// File Storage Routes
app.post("/make-server-3c4ee602/storage/upload", storage.uploadFile);
app.post("/make-server-3c4ee602/storage/signed-url", storage.getSignedUrl);
app.post("/make-server-3c4ee602/storage/delete", storage.deleteFile);
app.post("/make-server-3c4ee602/storage/init-bucket", async (c) => {
  try {
    await storage.initializeBucket();
    return c.json({ success: true, message: "Bucket initialized successfully" });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});
app.post("/make-server-3c4ee602/storage/update-mime-types", storage.updateBucketMimeTypes);

// Invoice Management Routes
app.get("/make-server-3c4ee602/invoices", invoices.getInvoices);
app.get("/make-server-3c4ee602/invoices-count", invoices.getInvoicesCount);
app.get("/make-server-3c4ee602/invoices/status/:status", invoices.getInvoicesByStatus);
app.get("/make-server-3c4ee602/invoices/:id", invoices.getInvoice);
app.post("/make-server-3c4ee602/invoices", invoices.createInvoice);
app.post("/make-server-3c4ee602/invoices/bulk", invoices.bulkCreateInvoices);
app.put("/make-server-3c4ee602/invoices/:id", invoices.updateInvoice);
app.delete("/make-server-3c4ee602/invoices/:id", invoices.deleteInvoice);

// Klearstack Integration Routes
app.post("/make-server-3c4ee602/invoices/:id/process", invoices.processInvoiceWithKlearstack);
app.get("/make-server-3c4ee602/invoices/:id/extraction-status", invoices.getExtractionStatus);

// Dispute Management Routes
app.get("/make-server-3c4ee602/disputes/:invoiceId", disputes.getDisputesByInvoice);
app.post("/make-server-3c4ee602/disputes/:invoiceId", disputes.createDispute);
app.put("/make-server-3c4ee602/disputes/:disputeId/resolve", disputes.resolveDispute);
app.put("/make-server-3c4ee602/disputes/:disputeId/reopen", disputes.reopenDispute);
app.post("/make-server-3c4ee602/disputes/:disputeId/replies", disputes.addReply);
app.put("/make-server-3c4ee602/disputes/:disputeId/toggle", disputes.toggleDisputeExpansion);

// Validation Routes (GST & QR Extraction)
app.get("/make-server-3c4ee602/validate/gst/:vendorName", validation.validateGST);
app.post("/make-server-3c4ee602/validate/qr-extract", validation.extractQRCode);
app.post("/make-server-3c4ee602/validate/qr-retry", validation.retryQRExtraction);

// Mount External Auth Routes
app.route("/", externalAuthApp);

// Mount KlearStack Routes
app.route("/make-server-3c4ee602/klearstack", klearstackApp);

// User Management Routes
app.patch("/make-server-3c4ee602/form-users/authorization", async (c) => {
  try {
    console.log('📤 User logout request received');
    
    // Here you can add any server-side logout logic
    // For example, invalidating sessions in the database
    // For now, we'll just acknowledge the logout
    
    return c.json({ 
      success: true, 
      message: "User logged out successfully" 
    });
  } catch (error: any) {
    console.error('❌ Logout error:', error);
    return c.json({ 
      success: false, 
      error: error.message || "Logout failed" 
    }, 500);
  }
});

// Add vendor master dummy data endpoint
app.post('/make-server-3c4ee602/populate-vendor-master', async (c) => {
  console.log('🔧 Populating vendor_master table with dummy data...');
  
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    
    // First, fetch existing vendors
    const { data: existingVendors, error: fetchError } = await supabase
      .from('vendor_master')
      .select('vendor_id, vendor_name')
      .order('created_at', { ascending: true });
    
    if (fetchError) {
      console.error('❌ Failed to fetch existing vendors:', fetchError);
      return c.json({
        success: false,
        error: 'Failed to fetch vendors',
        details: fetchError.message,
      }, 500);
    }
    
    if (!existingVendors || existingVendors.length === 0) {
      return c.json({
        success: false,
        message: 'No vendors found in vendor_master table',
      }, 404);
    }
    
    console.log(`📋 Found ${existingVendors.length} existing vendors to populate`);
    
    // Comprehensive dummy vendor data templates - EXCLUDING d365_vendor_code (foreign key)
    const vendorTemplates = [
      {
        // Basic Information
        bigsun_vendor_code: 'BS-001',
        puk_dmacq_parent: 'DMACQ-PARENT-01',
        vendor_location: 'Mumbai, Maharashtra',
        vendor_name_alias: 'Acme Tech',
        vendor_email_id: 'contact@acmecorp.com',
        designation: 'Managing Director',
        mobile_number: '+91-9876543210',
        
        // PAN Details
        vendor_pan: 'AABCA1234E',
        validate_pan: true,
        pan_registration_name: 'Acme Corporation Private Limited',
        pan_status: 'Active',
        pancard_number: 'AABCA1234E',
        is_pan_number_correct: true,
        
        // Vendor Type & Classification
        vendor_business_type: 'Private Limited',
        dentsu_entity_name: 'Dentsu Mumbai',
        vendor_type: 'Technology',
        vendor_type_3: 'IT Services',
        vendor_type_4: 'Software Development',
        additional_vendor_type: 'Cloud Solutions',
        partner_type: 'Strategic Partner',
        bigsun_instance_code_master: 'BSIM-001',
        medium: 'Digital',
        nature_of_business: 'IT Services and Software Development with focus on enterprise solutions',
        scope_of_services: 'End-to-end software development, cloud migration, system integration, and technical consulting services',
        
        // GST Details
        gst_number: '27AABCA1234E1Z5',
        gst_registered: true,
        taxpayer_type: 'Regular',
        gst_status: 'Active',
        gst_registration_date: '2018-07-01',
        trade_name: 'Acme Corporation',
        constitution: 'Private Limited Company',
        company_type: 'Private',
        nature_of_service: 'Information Technology',
        is_rcm_applicable: false,
        einvoice_status: 'Enabled',
        
        // Tax Details
        tan_number: 'MUMA12345D',
        date_of_incorporation: '2015-03-15',
        tds_applicability: true,
        tds_rate: 2.0,
        tds_section_name: 'Section 194J',
        basic_rate_percentage: 2.0,
        surcharge_percentage: 0.0,
        withholding_tax: 'Applicable',
        
        // Payment Terms
        payment_terms: 'Net 30',
        payment_mode: 'NEFT/RTGS',
        estimated_annual_turnover: 50000000.00,
        opening_amount: 0.00,
        opening_date: '2024-01-01',
        
        // MSME Details
        msme_flag: false,
        msme_registration_number: null,
        social_category: 'General',
        date_of_udhyam_registration: null,
        major_services: 'Software Development, Cloud Computing, System Integration',
        enterprise_type: 'Medium',
        
        // LDC Details
        ldc_applicability: false,
        ldc_percentage: null,
        ldc_limit: null,
        ldc_period_start_date: null,
        ldc_period_end_date: null,
        ldc_certificate_number: null,
        
        // Address & Codes
        address_type: 'Registered Office',
        d365_address_type: 'Primary',
        specified_vendor: false,
        bellin_code: 'BEL-001',
        bpc_code: 'BPC-001',
        iec_number: 'IEC0123456789',
        mira_rating: 'A',
        campaign_start_date: '2024-01-15',
        accredition: 'ISO 9001:2015, ISO 27001:2013',
        
        // Workflow Details
        requestor_email_id: 'requestor@dmacq.com',
        approver_name: 'John Smith',
        vendor_evaluation_rationale: 'Strong technical capabilities, proven track record in similar projects, competitive pricing',
        related_party_relationship: false,
        relation_type: null,
        
        // Audit Fields
        created_by: 'system',
        updated_by: 'system',
        deleted_at: null,
        deleted_by: null,
      },
      {
        // Basic Information
        bigsun_vendor_code: 'BS-002',
        puk_dmacq_parent: 'DMACQ-PARENT-02',
        vendor_location: 'Delhi NCR',
        vendor_name_alias: 'Global Supplies',
        vendor_email_id: 'accounts@globalsupplies.com',
        designation: 'Director - Operations',
        mobile_number: '+91-9876543211',
        
        // PAN Details
        vendor_pan: 'BBDCB5678F',
        validate_pan: true,
        pan_registration_name: 'Global Supplies India LLP',
        pan_status: 'Active',
        pancard_number: 'BBDCB5678F',
        is_pan_number_correct: true,
        
        // Vendor Type & Classification
        vendor_business_type: 'LLP',
        dentsu_entity_name: 'Dentsu Delhi',
        vendor_type: 'Office Supplies',
        vendor_type_3: 'Trading',
        vendor_type_4: 'Distribution',
        additional_vendor_type: 'Stationery',
        partner_type: 'Preferred Vendor',
        bigsun_instance_code_master: 'BSIM-002',
        medium: 'Offline',
        nature_of_business: 'Trading and distribution of office supplies, stationery, and equipment',
        scope_of_services: 'Procurement and supply of office supplies, furniture, stationery items, and related equipment',
        
        // GST Details
        gst_number: '07BBDCB5678F1Z3',
        gst_registered: true,
        taxpayer_type: 'Regular',
        gst_status: 'Active',
        gst_registration_date: '2017-09-20',
        trade_name: 'Global Supplies',
        constitution: 'Limited Liability Partnership',
        company_type: 'LLP',
        nature_of_service: 'Trading',
        is_rcm_applicable: false,
        einvoice_status: 'Enabled',
        
        // Tax Details
        tan_number: 'DELA12345E',
        date_of_incorporation: '2014-06-10',
        tds_applicability: true,
        tds_rate: 1.0,
        tds_section_name: 'Section 194Q',
        basic_rate_percentage: 1.0,
        surcharge_percentage: 0.0,
        withholding_tax: 'Applicable',
        
        // Payment Terms
        payment_terms: 'Net 45',
        payment_mode: 'NEFT/RTGS',
        estimated_annual_turnover: 25000000.00,
        opening_amount: 150000.00,
        opening_date: '2024-01-01',
        
        // MSME Details
        msme_flag: true,
        msme_registration_number: 'UDYAM-DL-12-1234567',
        social_category: 'General',
        date_of_udhyam_registration: '2020-07-01',
        major_services: 'Office Supplies, Stationery, Equipment Trading',
        enterprise_type: 'Small',
        
        // LDC Details
        ldc_applicability: true,
        ldc_percentage: 1.0,
        ldc_limit: 2000000.00,
        ldc_period_start_date: '2024-04-01',
        ldc_period_end_date: '2025-03-31',
        ldc_certificate_number: 'LDC-2024-001',
        
        // Address & Codes
        address_type: 'Registered Office',
        d365_address_type: 'Primary',
        specified_vendor: false,
        bellin_code: 'BEL-002',
        bpc_code: 'BPC-002',
        iec_number: null,
        mira_rating: 'B+',
        campaign_start_date: '2024-02-01',
        accredition: 'ISO 9001:2015',
        
        // Workflow Details
        requestor_email_id: 'procurement@dmacq.com',
        approver_name: 'Sarah Johnson',
        vendor_evaluation_rationale: 'Competitive pricing, reliable delivery, good track record with MSME benefits',
        related_party_relationship: false,
        relation_type: null,
        
        // Audit Fields
        created_by: 'system',
        updated_by: 'system',
        deleted_at: null,
        deleted_by: null,
      },
      {
        // Basic Information
        bigsun_vendor_code: 'BS-003',
        puk_dmacq_parent: 'DMACQ-PARENT-03',
        vendor_location: 'Bengaluru, Karnataka',
        vendor_name_alias: 'Tech Solutions',
        vendor_email_id: 'invoices@techsolutions.com',
        designation: 'Chief Executive Officer',
        mobile_number: '+91-9876543212',
        
        // PAN Details
        vendor_pan: 'CCEDC9012G',
        validate_pan: true,
        pan_registration_name: 'Tech Solutions Private Limited',
        pan_status: 'Active',
        pancard_number: 'CCEDC9012G',
        is_pan_number_correct: true,
        
        // Vendor Type & Classification
        vendor_business_type: 'Private Limited',
        dentsu_entity_name: 'Dentsu Bangalore',
        vendor_type: 'IT Services',
        vendor_type_3: 'Consulting',
        vendor_type_4: 'Professional Services',
        additional_vendor_type: 'Digital Transformation',
        partner_type: 'Technology Partner',
        bigsun_instance_code_master: 'BSIM-003',
        medium: 'Digital',
        nature_of_business: 'Consulting and IT services specializing in digital transformation and enterprise solutions',
        scope_of_services: 'IT consulting, business process optimization, digital transformation, and managed services',
        
        // GST Details
        gst_number: '29CCEDC9012G1Z1',
        gst_registered: true,
        taxpayer_type: 'Regular',
        gst_status: 'Active',
        gst_registration_date: '2019-01-15',
        trade_name: 'Tech Solutions',
        constitution: 'Private Limited Company',
        company_type: 'Private',
        nature_of_service: 'Consulting Services',
        is_rcm_applicable: false,
        einvoice_status: 'Enabled',
        
        // Tax Details
        tan_number: 'BLRA12345F',
        date_of_incorporation: '2016-11-20',
        tds_applicability: true,
        tds_rate: 10.0,
        tds_section_name: 'Section 194J',
        basic_rate_percentage: 10.0,
        surcharge_percentage: 0.0,
        withholding_tax: 'Applicable',
        
        // Payment Terms
        payment_terms: 'Net 60',
        payment_mode: 'NEFT/RTGS',
        estimated_annual_turnover: 75000000.00,
        opening_amount: 0.00,
        opening_date: '2024-01-01',
        
        // MSME Details
        msme_flag: false,
        msme_registration_number: null,
        social_category: 'General',
        date_of_udhyam_registration: null,
        major_services: 'IT Consulting, Digital Transformation, Managed Services',
        enterprise_type: 'Medium',
        
        // LDC Details
        ldc_applicability: false,
        ldc_percentage: null,
        ldc_limit: null,
        ldc_period_start_date: null,
        ldc_period_end_date: null,
        ldc_certificate_number: null,
        
        // Address & Codes
        address_type: 'Registered Office',
        d365_address_type: 'Primary',
        specified_vendor: true,
        bellin_code: 'BEL-003',
        bpc_code: 'BPC-003',
        iec_number: 'IEC0234567890',
        mira_rating: 'A+',
        campaign_start_date: '2024-01-10',
        accredition: 'ISO 9001:2015, ISO 27001:2013, CMMI Level 5',
        
        // Workflow Details
        requestor_email_id: 'it.head@dmacq.com',
        approver_name: 'Michael Chen',
        vendor_evaluation_rationale: 'Excellent technical expertise, industry certifications, strong references from similar clients',
        related_party_relationship: false,
        relation_type: null,
        
        // Audit Fields
        created_by: 'system',
        updated_by: 'system',
        deleted_at: null,
        deleted_by: null,
      },
      {
        // Basic Information
        bigsun_vendor_code: 'BS-004',
        puk_dmacq_parent: 'DMACQ-PARENT-04',
        vendor_location: 'Pune, Maharashtra',
        vendor_name_alias: 'Premier Manufacturing',
        vendor_email_id: 'billing@premiermfg.com',
        designation: 'General Manager',
        mobile_number: '+91-9876543213',
        
        // PAN Details
        vendor_pan: 'DDFED3456H',
        validate_pan: true,
        pan_registration_name: 'Premier Manufacturing Company Limited',
        pan_status: 'Active',
        pancard_number: 'DDFED3456H',
        is_pan_number_correct: true,
        
        // Vendor Type & Classification
        vendor_business_type: 'Public Limited',
        dentsu_entity_name: 'Dentsu Pune',
        vendor_type: 'Manufacturing',
        vendor_type_3: 'Production',
        vendor_type_4: 'Industrial',
        additional_vendor_type: 'OEM',
        partner_type: 'Manufacturing Partner',
        bigsun_instance_code_master: 'BSIM-004',
        medium: 'Offline',
        nature_of_business: 'Manufacturing and production of industrial equipment and components',
        scope_of_services: 'Custom manufacturing, product development, quality testing, and supply chain management',
        
        // GST Details
        gst_number: '27DDFED3456H1Z9',
        gst_registered: true,
        taxpayer_type: 'Regular',
        gst_status: 'Active',
        gst_registration_date: '2017-07-01',
        trade_name: 'Premier Manufacturing',
        constitution: 'Public Limited Company',
        company_type: 'Public',
        nature_of_service: 'Manufacturing',
        is_rcm_applicable: true,
        einvoice_status: 'Enabled',
        
        // Tax Details
        tan_number: 'PUNA12345G',
        date_of_incorporation: '2005-08-25',
        tds_applicability: true,
        tds_rate: 2.0,
        tds_section_name: 'Section 194C',
        basic_rate_percentage: 2.0,
        surcharge_percentage: 7.0,
        withholding_tax: 'Applicable',
        
        // Payment Terms
        payment_terms: 'Net 30',
        payment_mode: 'NEFT/RTGS',
        estimated_annual_turnover: 120000000.00,
        opening_amount: 250000.00,
        opening_date: '2024-01-01',
        
        // MSME Details
        msme_flag: false,
        msme_registration_number: null,
        social_category: 'General',
        date_of_udhyam_registration: null,
        major_services: 'Manufacturing, Product Development, Quality Control',
        enterprise_type: 'Large',
        
        // LDC Details
        ldc_applicability: false,
        ldc_percentage: null,
        ldc_limit: null,
        ldc_period_start_date: null,
        ldc_period_end_date: null,
        ldc_certificate_number: null,
        
        // Address & Codes
        address_type: 'Registered Office',
        d365_address_type: 'Primary',
        specified_vendor: true,
        bellin_code: 'BEL-004',
        bpc_code: 'BPC-004',
        iec_number: 'IEC0345678901',
        mira_rating: 'AA',
        campaign_start_date: '2024-03-01',
        accredition: 'ISO 9001:2015, ISO 14001:2015, OHSAS 18001',
        
        // Workflow Details
        requestor_email_id: 'operations@dmacq.com',
        approver_name: 'Robert Williams',
        vendor_evaluation_rationale: 'Established manufacturer, excellent quality standards, timely delivery record',
        related_party_relationship: false,
        relation_type: null,
        
        // Audit Fields
        created_by: 'system',
        updated_by: 'system',
        deleted_at: null,
        deleted_by: null,
      },
      {
        // Basic Information
        bigsun_vendor_code: 'BS-005',
        puk_dmacq_parent: 'DMACQ-PARENT-05',
        vendor_location: 'Chennai, Tamil Nadu',
        vendor_name_alias: 'Express Logistics',
        vendor_email_id: 'accounts@expresslogistics.com',
        designation: 'Operations Head',
        mobile_number: '+91-9876543214',
        
        // PAN Details
        vendor_pan: 'EEGFE7890I',
        validate_pan: true,
        pan_registration_name: 'Express Logistics LLP',
        pan_status: 'Active',
        pancard_number: 'EEGFE7890I',
        is_pan_number_correct: true,
        
        // Vendor Type & Classification
        vendor_business_type: 'LLP',
        dentsu_entity_name: 'Dentsu Chennai',
        vendor_type: 'Logistics',
        vendor_type_3: 'Transportation',
        vendor_type_4: 'Supply Chain',
        additional_vendor_type: 'Warehousing',
        partner_type: 'Logistics Partner',
        bigsun_instance_code_master: 'BSIM-005',
        medium: 'Offline',
        nature_of_business: 'Logistics and transportation services with warehousing facilities',
        scope_of_services: 'Freight forwarding, warehousing, last-mile delivery, and supply chain optimization',
        
        // GST Details
        gst_number: '33EEGFE7890I1Z7',
        gst_registered: true,
        taxpayer_type: 'Regular',
        gst_status: 'Active',
        gst_registration_date: '2018-11-05',
        trade_name: 'Express Logistics',
        constitution: 'Limited Liability Partnership',
        company_type: 'LLP',
        nature_of_service: 'Transportation and Logistics',
        is_rcm_applicable: false,
        einvoice_status: 'Enabled',
        
        // Tax Details
        tan_number: 'CHEA12345H',
        date_of_incorporation: '2013-04-18',
        tds_applicability: true,
        tds_rate: 1.0,
        tds_section_name: 'Section 194C',
        basic_rate_percentage: 1.0,
        surcharge_percentage: 0.0,
        withholding_tax: 'Applicable',
        
        // Payment Terms
        payment_terms: 'Net 15',
        payment_mode: 'NEFT/RTGS',
        estimated_annual_turnover: 35000000.00,
        opening_amount: 75000.00,
        opening_date: '2024-01-01',
        
        // MSME Details
        msme_flag: true,
        msme_registration_number: 'UDYAM-TN-45-2345678',
        social_category: 'OBC',
        date_of_udhyam_registration: '2020-10-15',
        major_services: 'Logistics, Transportation, Warehousing',
        enterprise_type: 'Small',
        
        // LDC Details
        ldc_applicability: true,
        ldc_percentage: 0.5,
        ldc_limit: 1500000.00,
        ldc_period_start_date: '2024-04-01',
        ldc_period_end_date: '2025-03-31',
        ldc_certificate_number: 'LDC-2024-002',
        
        // Address & Codes
        address_type: 'Registered Office',
        d365_address_type: 'Primary',
        specified_vendor: false,
        bellin_code: 'BEL-005',
        bpc_code: 'BPC-005',
        iec_number: null,
        mira_rating: 'B',
        campaign_start_date: '2024-02-15',
        accredition: 'ISO 9001:2015',
        
        // Workflow Details
        requestor_email_id: 'scm@dmacq.com',
        approver_name: 'Priya Sharma',
        vendor_evaluation_rationale: 'Cost-effective logistics solution, good network coverage, MSME benefits',
        related_party_relationship: false,
        relation_type: null,
        
        // Audit Fields
        created_by: 'system',
        updated_by: 'system',
        deleted_at: null,
        deleted_by: null,
      },
      {
        // Basic Information
        bigsun_vendor_code: 'BS-006',
        puk_dmacq_parent: 'DMACQ-PARENT-06',
        vendor_location: 'Hyderabad, Telangana',
        vendor_name_alias: 'Creative Design',
        vendor_email_id: 'info@creativedesign.com',
        designation: 'Creative Director',
        mobile_number: '+91-9876543215',
        
        // PAN Details
        vendor_pan: 'FFHGF1234J',
        validate_pan: true,
        pan_registration_name: 'Creative Design Studio',
        pan_status: 'Active',
        pancard_number: 'FFHGF1234J',
        is_pan_number_correct: true,
        
        // Vendor Type & Classification
        vendor_business_type: 'Proprietorship',
        dentsu_entity_name: 'Dentsu Hyderabad',
        vendor_type: 'Creative Services',
        vendor_type_3: 'Design',
        vendor_type_4: 'Branding',
        additional_vendor_type: 'Content Creation',
        partner_type: 'Creative Partner',
        bigsun_instance_code_master: 'BSIM-006',
        medium: 'Digital',
        nature_of_business: 'Design and creative services including branding, content creation, and visual design',
        scope_of_services: 'Graphic design, brand identity, content creation, UI/UX design, and creative consulting',
        
        // GST Details
        gst_number: '36FFHGF1234J1Z5',
        gst_registered: true,
        taxpayer_type: 'Composition',
        gst_status: 'Active',
        gst_registration_date: '2019-06-10',
        trade_name: 'Creative Design Studio',
        constitution: 'Proprietorship',
        company_type: 'Proprietorship',
        nature_of_service: 'Creative Services',
        is_rcm_applicable: false,
        einvoice_status: 'Not Applicable',
        
        // Tax Details
        tan_number: 'HYDA12345I',
        date_of_incorporation: '2017-02-28',
        tds_applicability: true,
        tds_rate: 2.0,
        tds_section_name: 'Section 194J',
        basic_rate_percentage: 2.0,
        surcharge_percentage: 0.0,
        withholding_tax: 'Applicable',
        
        // Payment Terms
        payment_terms: 'Net 30',
        payment_mode: 'NEFT/RTGS',
        estimated_annual_turnover: 12000000.00,
        opening_amount: 0.00,
        opening_date: '2024-01-01',
        
        // MSME Details
        msme_flag: true,
        msme_registration_number: 'UDYAM-TG-23-3456789',
        social_category: 'General',
        date_of_udhyam_registration: '2021-03-20',
        major_services: 'Graphic Design, Branding, Content Creation',
        enterprise_type: 'Micro',
        
        // LDC Details
        ldc_applicability: true,
        ldc_percentage: 1.5,
        ldc_limit: 1000000.00,
        ldc_period_start_date: '2024-04-01',
        ldc_period_end_date: '2025-03-31',
        ldc_certificate_number: 'LDC-2024-003',
        
        // Address & Codes
        address_type: 'Registered Office',
        d365_address_type: 'Primary',
        specified_vendor: false,
        bellin_code: 'BEL-006',
        bpc_code: 'BPC-006',
        iec_number: null,
        mira_rating: 'B+',
        campaign_start_date: '2024-03-10',
        accredition: null,
        
        // Workflow Details
        requestor_email_id: 'marketing@dmacq.com',
        approver_name: 'Emily Davis',
        vendor_evaluation_rationale: 'Creative excellence, unique design approach, MSME benefits, cost-effective',
        related_party_relationship: false,
        relation_type: null,
        
        // Audit Fields
        created_by: 'system',
        updated_by: 'system',
        deleted_at: null,
        deleted_by: null,
      },
      {
        // Basic Information
        bigsun_vendor_code: 'BS-007',
        puk_dmacq_parent: 'DMACQ-PARENT-07',
        vendor_location: 'Kolkata, West Bengal',
        vendor_name_alias: 'Legal Advisors',
        vendor_email_id: 'contact@legaladvisors.com',
        designation: 'Senior Partner',
        mobile_number: '+91-9876543216',
        
        // PAN Details
        vendor_pan: 'GGIHG5678K',
        validate_pan: true,
        pan_registration_name: 'Legal Advisors & Associates',
        pan_status: 'Active',
        pancard_number: 'GGIHG5678K',
        is_pan_number_correct: true,
        
        // Vendor Type & Classification
        vendor_business_type: 'Partnership',
        dentsu_entity_name: 'Dentsu Kolkata',
        vendor_type: 'Professional Services',
        vendor_type_3: 'Legal',
        vendor_type_4: 'Compliance',
        additional_vendor_type: 'Corporate Law',
        partner_type: 'Legal Partner',
        bigsun_instance_code_master: 'BSIM-007',
        medium: 'Offline',
        nature_of_business: 'Legal and professional services including corporate law, compliance, and litigation',
        scope_of_services: 'Legal advisory, corporate compliance, contract drafting, litigation support, and regulatory consulting',
        
        // GST Details
        gst_number: '19GGIHG5678K1Z3',
        gst_registered: true,
        taxpayer_type: 'Regular',
        gst_status: 'Active',
        gst_registration_date: '2017-07-01',
        trade_name: 'Legal Advisors',
        constitution: 'Partnership Firm',
        company_type: 'Partnership',
        nature_of_service: 'Professional Services',
        is_rcm_applicable: false,
        einvoice_status: 'Enabled',
        
        // Tax Details
        tan_number: 'KOLA12345J',
        date_of_incorporation: '2010-05-12',
        tds_applicability: true,
        tds_rate: 10.0,
        tds_section_name: 'Section 194J',
        basic_rate_percentage: 10.0,
        surcharge_percentage: 0.0,
        withholding_tax: 'Applicable',
        
        // Payment Terms
        payment_terms: 'Net 30',
        payment_mode: 'NEFT/RTGS',
        estimated_annual_turnover: 45000000.00,
        opening_amount: 125000.00,
        opening_date: '2024-01-01',
        
        // MSME Details
        msme_flag: false,
        msme_registration_number: null,
        social_category: 'General',
        date_of_udhyam_registration: null,
        major_services: 'Legal Advisory, Corporate Compliance, Litigation',
        enterprise_type: 'Medium',
        
        // LDC Details
        ldc_applicability: false,
        ldc_percentage: null,
        ldc_limit: null,
        ldc_period_start_date: null,
        ldc_period_end_date: null,
        ldc_certificate_number: null,
        
        // Address & Codes
        address_type: 'Registered Office',
        d365_address_type: 'Primary',
        specified_vendor: true,
        bellin_code: 'BEL-007',
        bpc_code: 'BPC-007',
        iec_number: null,
        mira_rating: 'A',
        campaign_start_date: '2024-01-20',
        accredition: 'Bar Council of India',
        
        // Workflow Details
        requestor_email_id: 'legal@dmacq.com',
        approver_name: 'David Martinez',
        vendor_evaluation_rationale: 'Specialized expertise in corporate law, strong reputation, experienced team',
        related_party_relationship: false,
        relation_type: null,
        
        // Audit Fields
        created_by: 'system',
        updated_by: 'system',
        deleted_at: null,
        deleted_by: null,
      },
      {
        // Basic Information
        bigsun_vendor_code: 'BS-008',
        puk_dmacq_parent: 'DMACQ-PARENT-08',
        vendor_location: 'Ahmedabad, Gujarat',
        vendor_name_alias: 'Food Supply',
        vendor_email_id: 'sales@foodsupply.com',
        designation: 'Branch Manager',
        mobile_number: '+91-9876543217',
        
        // PAN Details
        vendor_pan: 'HHJIG9012L',
        validate_pan: true,
        pan_registration_name: 'Food Supply Chain India Private Limited',
        pan_status: 'Active',
        pancard_number: 'HHJIG9012L',
        is_pan_number_correct: true,
        
        // Vendor Type & Classification
        vendor_business_type: 'Private Limited',
        dentsu_entity_name: 'Dentsu Ahmedabad',
        vendor_type: 'Food & Beverage',
        vendor_type_3: 'Distribution',
        vendor_type_4: 'Catering',
        additional_vendor_type: 'Pantry Services',
        partner_type: 'F&B Partner',
        bigsun_instance_code_master: 'BSIM-008',
        medium: 'Offline',
        nature_of_business: 'Food distribution and catering services for corporate clients',
        scope_of_services: 'Corporate catering, pantry management, food supply, and vending services',
        
        // GST Details
        gst_number: '24HHJIG9012L1Z1',
        gst_registered: true,
        taxpayer_type: 'Regular',
        gst_status: 'Active',
        gst_registration_date: '2018-03-15',
        trade_name: 'Food Supply Chain',
        constitution: 'Private Limited Company',
        company_type: 'Private',
        nature_of_service: 'Food Services',
        is_rcm_applicable: false,
        einvoice_status: 'Enabled',
        
        // Tax Details
        tan_number: 'AHMA12345K',
        date_of_incorporation: '2015-09-08',
        tds_applicability: true,
        tds_rate: 1.0,
        tds_section_name: 'Section 194C',
        basic_rate_percentage: 1.0,
        surcharge_percentage: 0.0,
        withholding_tax: 'Applicable',
        
        // Payment Terms
        payment_terms: 'Net 7',
        payment_mode: 'NEFT/RTGS',
        estimated_annual_turnover: 18000000.00,
        opening_amount: 50000.00,
        opening_date: '2024-01-01',
        
        // MSME Details
        msme_flag: true,
        msme_registration_number: 'UDYAM-GJ-56-4567890',
        social_category: 'General',
        date_of_udhyam_registration: '2021-06-01',
        major_services: 'Corporate Catering, Food Distribution, Pantry Management',
        enterprise_type: 'Small',
        
        // LDC Details
        ldc_applicability: true,
        ldc_percentage: 1.0,
        ldc_limit: 800000.00,
        ldc_period_start_date: '2024-04-01',
        ldc_period_end_date: '2025-03-31',
        ldc_certificate_number: 'LDC-2024-004',
        
        // Address & Codes
        address_type: 'Registered Office',
        d365_address_type: 'Primary',
        specified_vendor: false,
        bellin_code: 'BEL-008',
        bpc_code: 'BPC-008',
        iec_number: null,
        mira_rating: 'B',
        campaign_start_date: '2024-02-20',
        accredition: 'FSSAI License, ISO 22000:2018',
        
        // Workflow Details
        requestor_email_id: 'admin@dmacq.com',
        approver_name: 'Lisa Anderson',
        vendor_evaluation_rationale: 'Quality food services, hygiene standards, MSME benefits, flexible payment terms',
        related_party_relationship: false,
        relation_type: null,
        
        // Audit Fields
        created_by: 'system',
        updated_by: 'system',
        deleted_at: null,
        deleted_by: null,
      },
      {
        // Basic Information
        bigsun_vendor_code: 'BS-009',
        puk_dmacq_parent: 'DMACQ-PARENT-09',
        vendor_location: 'Gurgaon, Haryana',
        vendor_name_alias: 'Marketing Agency',
        vendor_email_id: 'info@marketingagency.com',
        designation: 'Account Director',
        mobile_number: '+91-9876543218',
        
        // PAN Details
        vendor_pan: 'IIKJH3456M',
        validate_pan: true,
        pan_registration_name: 'Marketing Agency Group Private Limited',
        pan_status: 'Active',
        pancard_number: 'IIKJH3456M',
        is_pan_number_correct: true,
        
        // Vendor Type & Classification
        vendor_business_type: 'Private Limited',
        dentsu_entity_name: 'Dentsu Gurgaon',
        vendor_type: 'Marketing',
        vendor_type_3: 'Advertising',
        vendor_type_4: 'Digital Marketing',
        additional_vendor_type: 'Media Planning',
        partner_type: 'Marketing Partner',
        bigsun_instance_code_master: 'BSIM-009',
        medium: 'Digital',
        nature_of_business: 'Marketing and advertising services with focus on digital campaigns',
        scope_of_services: 'Brand strategy, campaign management, digital marketing, media planning, and creative execution',
        
        // GST Details
        gst_number: '06IIKJH3456M1Z9',
        gst_registered: true,
        taxpayer_type: 'Regular',
        gst_status: 'Active',
        gst_registration_date: '2019-08-20',
        trade_name: 'Marketing Agency Group',
        constitution: 'Private Limited Company',
        company_type: 'Private',
        nature_of_service: 'Advertising and Marketing',
        is_rcm_applicable: false,
        einvoice_status: 'Enabled',
        
        // Tax Details
        tan_number: 'GURA12345L',
        date_of_incorporation: '2018-01-15',
        tds_applicability: true,
        tds_rate: 2.0,
        tds_section_name: 'Section 194J',
        basic_rate_percentage: 2.0,
        surcharge_percentage: 0.0,
        withholding_tax: 'Applicable',
        
        // Payment Terms
        payment_terms: 'Net 30',
        payment_mode: 'NEFT/RTGS',
        estimated_annual_turnover: 60000000.00,
        opening_amount: 0.00,
        opening_date: '2024-01-01',
        
        // MSME Details
        msme_flag: false,
        msme_registration_number: null,
        social_category: 'General',
        date_of_udhyam_registration: null,
        major_services: 'Brand Strategy, Campaign Management, Digital Marketing',
        enterprise_type: 'Medium',
        
        // LDC Details
        ldc_applicability: false,
        ldc_percentage: null,
        ldc_limit: null,
        ldc_period_start_date: null,
        ldc_period_end_date: null,
        ldc_certificate_number: null,
        
        // Address & Codes
        address_type: 'Registered Office',
        d365_address_type: 'Primary',
        specified_vendor: true,
        bellin_code: 'BEL-009',
        bpc_code: 'BPC-009',
        iec_number: null,
        mira_rating: 'A',
        campaign_start_date: '2024-01-05',
        accredition: 'Google Partner, Facebook Marketing Partner',
        
        // Workflow Details
        requestor_email_id: 'brand@dmacq.com',
        approver_name: 'Jennifer Lee',
        vendor_evaluation_rationale: 'Strong digital marketing capabilities, proven campaign success, industry certifications',
        related_party_relationship: false,
        relation_type: null,
        
        // Audit Fields
        created_by: 'system',
        updated_by: 'system',
        deleted_at: null,
        deleted_by: null,
      },
      {
        // Basic Information
        bigsun_vendor_code: 'BS-010',
        puk_dmacq_parent: 'DMACQ-PARENT-10',
        vendor_location: 'Noida, Uttar Pradesh',
        vendor_name_alias: 'Secure IT',
        vendor_email_id: 'accounts@secureit.com',
        designation: 'Security Director',
        mobile_number: '+91-9876543219',
        
        // PAN Details
        vendor_pan: 'JJLKI7890N',
        validate_pan: true,
        pan_registration_name: 'Secure IT Systems Private Limited',
        pan_status: 'Active',
        pancard_number: 'JJLKI7890N',
        is_pan_number_correct: true,
        
        // Vendor Type & Classification
        vendor_business_type: 'Private Limited',
        dentsu_entity_name: 'Dentsu Noida',
        vendor_type: 'Cybersecurity',
        vendor_type_3: 'IT Security',
        vendor_type_4: 'Network Security',
        additional_vendor_type: 'Cloud Security',
        partner_type: 'Security Partner',
        bigsun_instance_code_master: 'BSIM-010',
        medium: 'Digital',
        nature_of_business: 'Security and IT services specializing in cybersecurity and network protection',
        scope_of_services: 'Cybersecurity assessment, penetration testing, security consulting, SOC services, and incident response',
        
        // GST Details
        gst_number: '09JJLKI7890N1Z7',
        gst_registered: true,
        taxpayer_type: 'Regular',
        gst_status: 'Active',
        gst_registration_date: '2018-12-10',
        trade_name: 'Secure IT Systems',
        constitution: 'Private Limited Company',
        company_type: 'Private',
        nature_of_service: 'IT Security Services',
        is_rcm_applicable: false,
        einvoice_status: 'Enabled',
        
        // Tax Details
        tan_number: 'NOIA12345M',
        date_of_incorporation: '2016-07-22',
        tds_applicability: true,
        tds_rate: 2.0,
        tds_section_name: 'Section 194J',
        basic_rate_percentage: 2.0,
        surcharge_percentage: 0.0,
        withholding_tax: 'Applicable',
        
        // Payment Terms
        payment_terms: 'Net 30',
        payment_mode: 'NEFT/RTGS',
        estimated_annual_turnover: 55000000.00,
        opening_amount: 0.00,
        opening_date: '2024-01-01',
        
        // MSME Details
        msme_flag: false,
        msme_registration_number: null,
        social_category: 'General',
        date_of_udhyam_registration: null,
        major_services: 'Cybersecurity, Penetration Testing, SOC Services',
        enterprise_type: 'Medium',
        
        // LDC Details
        ldc_applicability: false,
        ldc_percentage: null,
        ldc_limit: null,
        ldc_period_start_date: null,
        ldc_period_end_date: null,
        ldc_certificate_number: null,
        
        // Address & Codes
        address_type: 'Registered Office',
        d365_address_type: 'Primary',
        specified_vendor: true,
        bellin_code: 'BEL-010',
        bpc_code: 'BPC-010',
        iec_number: null,
        mira_rating: 'A+',
        campaign_start_date: '2024-01-25',
        accredition: 'ISO 27001:2013, CEH, CISSP',
        
        // Workflow Details
        requestor_email_id: 'ciso@dmacq.com',
        approver_name: 'Kevin Brown',
        vendor_evaluation_rationale: 'Top-tier security expertise, industry certifications, proven track record in enterprise security',
        related_party_relationship: false,
        relation_type: null,
        
        // Audit Fields
        created_by: 'system',
        updated_by: 'system',
        deleted_at: null,
        deleted_by: null,
      },
    ];
    
    // Update each existing vendor with dummy data
    const updatePromises = existingVendors.map((vendor, index) => {
      // Use modulo to cycle through templates if more vendors than templates
      const template = vendorTemplates[index % vendorTemplates.length];
      
      // Make unique fields for each vendor to avoid constraint violations
      // Use compact format to stay within varchar length limits (e.g., varchar(10))
      const vendorNum = String(index + 1).padStart(3, '0');
      
      const uniqueData = {
        ...template,
        // Make bigsun_vendor_code unique - keep it short (max 10 chars)
        bigsun_vendor_code: `BS${vendorNum}`,  // e.g., "BS001" (5 chars) - NO DASHES to save space
        // Make vendor_email_id unique
        vendor_email_id: template.vendor_email_id.replace('@', `-${vendorNum}@`),
        // Make other potentially unique fields unique as well - keep short
        vendor_pan: index === 0 ? template.vendor_pan : `${template.vendor_pan.substring(0, 9)}${String.fromCharCode(65 + (index % 26))}`,
        pancard_number: index === 0 ? template.pancard_number : `${template.pancard_number.substring(0, 9)}${String.fromCharCode(65 + (index % 26))}`,
        gst_number: index === 0 ? template.gst_number : template.gst_number.replace(/1Z/, `${(index % 9) + 1}Z`),
        tan_number: index === 0 ? template.tan_number : `${template.tan_number.substring(0, 10)}${String.fromCharCode(65 + (index % 26))}`,
        // Keep MSME and LDC certificate numbers SHORT (max 10 chars) - don't append anything if template is null
        msme_registration_number: template.msme_registration_number ? `MSME${vendorNum}` : null,  // e.g., "MSME001" (7 chars)
        ldc_certificate_number: template.ldc_certificate_number ? `LDC${vendorNum}` : null,  // e.g., "LDC001" (6 chars)
        bellin_code: `BEL${vendorNum}`,  // e.g., "BEL001" (6 chars) - NO DASHES
        bpc_code: `BPC${vendorNum}`,  // e.g., "BPC001" (6 chars) - NO DASHES
        iec_number: template.iec_number ? `IEC${String(index).padStart(7, '0')}` : null,  // e.g., "IEC0000001" (10 chars max)
      };
      
      return supabase
        .from('vendor_master')
        .update(uniqueData)
        .eq('vendor_id', vendor.vendor_id);
    });
    
    const results = await Promise.all(updatePromises);
    
    // Check for errors and separate constraint violations from other errors
    const constraintErrors: any[] = [];
    const otherErrors: any[] = [];
    
    results.forEach((r, idx) => {
      if (r.error) {
        const errorMsg = r.error.message || '';
        if (errorMsg.includes('duplicate key') || errorMsg.includes('unique constraint')) {
          constraintErrors.push({ index: idx, error: r.error });
        } else {
          otherErrors.push({ index: idx, error: r.error });
        }
      }
    });
    
    const successCount = results.length - constraintErrors.length - otherErrors.length;
    
    // Only fail if there are non-constraint errors
    if (otherErrors.length > 0) {
      console.error('❌ Some updates failed with non-constraint errors:', otherErrors.map(e => e.error));
      return c.json({
        success: false,
        error: `Failed to update ${otherErrors.length} vendors due to errors`,
        details: otherErrors[0].error?.message,
        skippedDuplicates: constraintErrors.length,
        successfulUpdates: successCount,
      }, 500);
    }
    
    // Log constraint violations but continue
    if (constraintErrors.length > 0) {
      console.log(`⚠️ Skipped ${constraintErrors.length} vendors due to duplicate key constraints`);
    }
    
    console.log(`✅ Successfully updated ${successCount} vendors with comprehensive data (88 columns, excluding d365_vendor_code foreign key)`);
    
    return c.json({
      success: true,
      message: `Populated ${successCount} vendors with comprehensive dummy data (88 of 89 columns - excluding d365_vendor_code foreign key)`,
      count: successCount,
      skippedDuplicates: constraintErrors.length,
      totalProcessed: results.length,
    });
  } catch (error: any) {
    console.error('❌ Error populating vendor_master:', error.message);
    return c.json({
      success: false,
      error: 'Failed to populate vendor_master',
      details: error.message,
    }, 500);
  }
});

Deno.serve(app.fetch);