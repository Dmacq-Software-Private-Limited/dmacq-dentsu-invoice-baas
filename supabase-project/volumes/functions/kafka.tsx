import { Kafka } from "npm:kafkajs@2.2.4";

const KAFKA_TOPIC = "invoices.ingest";

// Initialize Kafka client and producer
export const getKafkaProducer = async () => {
  const brokers = Deno.env.get("KAFKA_BROKERS") || "192.168.0.224:9092";
  const clientId = Deno.env.get("KAFKA_CLIENT_ID") || "invoice-workers";
  
  const kafka = new Kafka({
    clientId: clientId,
    brokers: brokers.split(","),
  });
  
  const producer = kafka.producer();
  await producer.connect();
  return producer;
};

// Send message to Kafka topic
export const sendToKafka = async (invoiceId: string, vendorId: string, storagePath: string, originalName: string) => {
  let producer: any = null;
  try {
    producer = await getKafkaProducer();
    
    // Generate UUID for idempotency
    const idempotency = crypto.randomUUID();
    
    // Generate ISO timestamp
    const ts = new Date().toISOString();
    
    const message = {
      invoice_id: invoiceId,
      vendor_id: vendorId,
      storage_path: storagePath,
      original: originalName,
      idempotency: idempotency,
      ts: ts,
    };
    
    await producer.send({
      topic: KAFKA_TOPIC,
      messages: [
        {
          value: JSON.stringify(message),
        },
      ],
    });
    
    console.log(`✅ Kafka message sent to ${KAFKA_TOPIC}:`, message);
  } catch (error: any) {
    console.error(`❌ Kafka error:`, error);
    // Create Kafka file with error structure
    await createKafkaErrorFile(invoiceId, vendorId, storagePath, originalName, error);
    throw error;
  } finally {
    // Ensure producer is always disconnected
    if (producer) {
      try {
        await producer.disconnect();
      } catch (disconnectError: any) {
        console.error(`⚠️ Error disconnecting Kafka producer:`, disconnectError.message);
      }
    }
  }
};

// Create Kafka error file when exception occurs
export const createKafkaErrorFile = async (invoiceId: string, vendorId: string, storagePath: string, originalName: string, error: any) => {
  try {
    // Generate UUID for idempotency
    const idempotency = crypto.randomUUID();
    
    // Generate ISO timestamp
    const ts = new Date().toISOString();
    
    const errorData = {
      invoice_id: invoiceId || "30ea08fd-dd88-472c-a630-b2ac82650593",
      vendor_id: vendorId,
      storage_path: storagePath || "",
      original: originalName,
      idempotency: idempotency,
      ts: ts,
    };
    
    // Log the error file structure
    console.error(`📝 Kafka error file structure:`, JSON.stringify(errorData, null, 2));
    console.error(`   Error details:`, error.message);
    
    // Write error file to a JSON file
    try {
      const errorDir = "kafka-errors";
      // Ensure directory exists (create if it doesn't)
      try {
        await Deno.mkdir(errorDir, { recursive: true });
      } catch {
        // Directory might already exist, ignore
      }
      
      const timestamp = Date.now();
      const errorFileName = `${errorDir}/kafka-error-${timestamp}.json`;
      await Deno.writeTextFile(errorFileName, JSON.stringify(errorData, null, 2));
      console.error(`   Error file written to: ${errorFileName}`);
    } catch (writeError: any) {
      console.error(`   ⚠️ Could not write error file to disk:`, writeError.message);
      // Continue - we've at least logged it
    }
  } catch (fileError: any) {
    console.error(`❌ Failed to create Kafka error file:`, fileError);
  }
};

