import type { Context } from "npm:hono";
import { createClient } from "npm:@supabase/supabase-js@2.39.0";

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// ========================================
// GET ALL DISPUTES FOR AN INVOICE
// ========================================
export async function getDisputesByInvoice(c: Context) {
  try {
    const invoiceId = c.req.param('invoiceId');
    
    if (!invoiceId) {
      return c.json({ error: 'Invoice ID is required' }, 400);
    }

    console.log(`📋 Fetching disputes for invoice: ${invoiceId}`);

    // Fetch disputes with replies and attachments
    const { data: disputes, error: disputesError } = await supabase
      .from('disputes_3c4ee602')
      .select(`
        *,
        replies:dispute_replies_3c4ee602 (
          *,
          attachments:dispute_attachments_3c4ee602 (*)
        )
      `)
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: false });

    if (disputesError) {
      console.error('❌ Error fetching disputes:', disputesError);
      return c.json({ error: disputesError.message }, 500);
    }

    console.log(`✅ Found ${disputes?.length || 0} disputes`);
    return c.json({ disputes: disputes || [] });
  } catch (error: any) {
    console.error('❌ Error in getDisputesByInvoice:', error);
    return c.json({ error: error.message }, 500);
  }
}

// ========================================
// CREATE A NEW DISPUTE
// ========================================
export async function createDispute(c: Context) {
  try {
    const invoiceId = c.req.param('invoiceId');
    const body = await c.req.json();
    
    if (!invoiceId) {
      return c.json({ error: 'Invoice ID is required' }, 400);
    }

    const { title, message, authorName = 'Dentsu User' } = body;

    if (!title || !message) {
      return c.json({ error: 'Title and message are required' }, 400);
    }

    console.log(`📝 Creating dispute for invoice: ${invoiceId}`);

    const { data: dispute, error: insertError } = await supabase
      .from('disputes_3c4ee602')
      .insert({
        invoice_id: invoiceId,
        title,
        message,
        status: 'Raised',
        author_name: authorName,
        is_expanded: false
      })
      .select()
      .single();

    if (insertError) {
      console.error('❌ Error creating dispute:', insertError);
      return c.json({ error: insertError.message }, 500);
    }

    console.log(`✅ Created dispute: ${dispute.id}`);
    
    // Also update invoice status to Disputed if not already
    await updateInvoiceDisputeStatus(invoiceId);

    return c.json({ dispute }, 201);
  } catch (error: any) {
    console.error('❌ Error in createDispute:', error);
    return c.json({ error: error.message }, 500);
  }
}

// ========================================
// RESOLVE A DISPUTE
// ========================================
export async function resolveDispute(c: Context) {
  try {
    const disputeId = c.req.param('disputeId');
    const body = await c.req.json();
    
    if (!disputeId) {
      return c.json({ error: 'Dispute ID is required' }, 400);
    }

    const { resolvedBy = 'Dentsu User' } = body;

    console.log(`✅ Resolving dispute: ${disputeId}`);

    const { data: dispute, error: updateError } = await supabase
      .from('disputes_3c4ee602')
      .update({
        status: 'Resolved',
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy
      })
      .eq('id', disputeId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Error resolving dispute:', updateError);
      return c.json({ error: updateError.message }, 500);
    }

    console.log(`✅ Dispute resolved: ${disputeId}`);
    
    // Check if all disputes for the invoice are resolved
    await checkAndUpdateInvoiceStatus(dispute.invoice_id);

    return c.json({ dispute });
  } catch (error: any) {
    console.error('❌ Error in resolveDispute:', error);
    return c.json({ error: error.message }, 500);
  }
}

// ========================================
// REOPEN A DISPUTE
// ========================================
export async function reopenDispute(c: Context) {
  try {
    const disputeId = c.req.param('disputeId');
    const body = await c.req.json();
    
    if (!disputeId) {
      return c.json({ error: 'Dispute ID is required' }, 400);
    }

    const { reopenedBy = 'Dentsu User' } = body;

    console.log(`🔄 Reopening dispute: ${disputeId}`);

    const { data: dispute, error: updateError } = await supabase
      .from('disputes_3c4ee602')
      .update({
        status: 'Reopened',
        reopened_at: new Date().toISOString(),
        reopened_by: reopenedBy
      })
      .eq('id', disputeId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Error reopening dispute:', updateError);
      return c.json({ error: updateError.message }, 500);
    }

    console.log(`✅ Dispute reopened: ${disputeId}`);
    
    // Update invoice status back to Disputed
    await updateInvoiceDisputeStatus(dispute.invoice_id);

    return c.json({ dispute });
  } catch (error: any) {
    console.error('❌ Error in reopenDispute:', error);
    return c.json({ error: error.message }, 500);
  }
}

// ========================================
// ADD A REPLY TO A DISPUTE
// ========================================
export async function addReply(c: Context) {
  try {
    const disputeId = c.req.param('disputeId');
    const body = await c.req.json();
    
    if (!disputeId) {
      return c.json({ error: 'Dispute ID is required' }, 400);
    }

    const { message, authorName = 'Dentsu Support', attachments = [] } = body;

    console.log(`�� Adding reply to dispute: ${disputeId}`);

    const { data: reply, error: replyError } = await supabase
      .from('dispute_replies_3c4ee602')
      .insert({
        dispute_id: disputeId,
        author_name: authorName,
        message: message || null
      })
      .select()
      .single();

    if (replyError) {
      console.error('❌ Error adding reply:', replyError);
      return c.json({ error: replyError.message }, 500);
    }

    // Add attachments if any
    if (attachments.length > 0) {
      const attachmentsToInsert = attachments.map((att: any) => ({
        reply_id: reply.id,
        file_name: att.name || att.fileName,
        file_type: att.type,
        file_size: att.size,
        storage_path: att.storagePath || null
      }));

      const { error: attachError } = await supabase
        .from('dispute_attachments_3c4ee602')
        .insert(attachmentsToInsert);

      if (attachError) {
        console.error('❌ Error adding attachments:', attachError);
        // Don't fail the whole request, just log the error
      }
    }

    console.log(`✅ Reply added: ${reply.id}`);

    return c.json({ reply }, 201);
  } catch (error: any) {
    console.error('❌ Error in addReply:', error);
    return c.json({ error: error.message }, 500);
  }
}

// ========================================
// TOGGLE DISPUTE EXPANSION
// ========================================
export async function toggleDisputeExpansion(c: Context) {
  try {
    const disputeId = c.req.param('disputeId');
    const body = await c.req.json();
    
    if (!disputeId) {
      return c.json({ error: 'Dispute ID is required' }, 400);
    }

    const { isExpanded } = body;

    const { data: dispute, error: updateError } = await supabase
      .from('disputes_3c4ee602')
      .update({ is_expanded: isExpanded })
      .eq('id', disputeId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Error toggling expansion:', updateError);
      return c.json({ error: updateError.message }, 500);
    }

    return c.json({ dispute });
  } catch (error: any) {
    console.error('❌ Error in toggleDisputeExpansion:', error);
    return c.json({ error: error.message }, 500);
  }
}

// ========================================
// HELPER FUNCTIONS
// ========================================

async function updateInvoiceDisputeStatus(invoiceId: string) {
  try {
    // Check if there are any active (non-resolved) disputes
    const { data: activeDisputes, error } = await supabase
      .from('disputes_3c4ee602')
      .select('id')
      .eq('invoice_id', invoiceId)
      .neq('status', 'Resolved');

    if (error) {
      console.error('❌ Error checking active disputes:', error);
      return;
    }

    // Update invoice status to Disputed if there are active disputes
    if (activeDisputes && activeDisputes.length > 0) {
      const { data: kvData } = await supabase
        .from('kv_store_3c4ee602')
        .select('value')
        .eq('key', invoiceId)
        .single();

      if (kvData) {
        const invoice = JSON.parse(kvData.value);
        invoice.status = 'Disputed';
        invoice.hasActiveDisputes = true;
        invoice.disputeCount = activeDisputes.length;

        await supabase
          .from('kv_store_3c4ee602')
          .update({ value: JSON.stringify(invoice) })
          .eq('key', invoiceId);

        console.log(`📌 Invoice ${invoiceId} marked as Disputed`);
      }
    }
  } catch (error: any) {
    console.error('❌ Error updating invoice dispute status:', error);
  }
}

async function checkAndUpdateInvoiceStatus(invoiceId: string) {
  try {
    // Check if all disputes are resolved
    const { data: unresolvedDisputes, error } = await supabase
      .from('disputes_3c4ee602')
      .select('id')
      .eq('invoice_id', invoiceId)
      .neq('status', 'Resolved');

    if (error) {
      console.error('❌ Error checking unresolved disputes:', error);
      return;
    }

    // If all disputes are resolved, update invoice status back to Pending
    if (!unresolvedDisputes || unresolvedDisputes.length === 0) {
      const { data: kvData } = await supabase
        .from('kv_store_3c4ee602')
        .select('value')
        .eq('key', invoiceId)
        .single();

      if (kvData) {
        const invoice = JSON.parse(kvData.value);
        invoice.status = 'Pending';
        invoice.hasActiveDisputes = false;
        invoice.disputeCount = 0;

        await supabase
          .from('kv_store_3c4ee602')
          .update({ value: JSON.stringify(invoice) })
          .eq('key', invoiceId);

        console.log(`📌 Invoice ${invoiceId} status updated to Pending (all disputes resolved)`);
      }
    }
  } catch (error: any) {
    console.error('❌ Error checking and updating invoice status:', error);
  }
}
