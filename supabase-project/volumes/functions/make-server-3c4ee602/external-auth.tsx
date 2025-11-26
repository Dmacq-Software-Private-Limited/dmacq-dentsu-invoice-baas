import { Hono } from 'npm:hono';
import { createClient } from 'npm:@supabase/supabase-js';
import { cors } from 'npm:hono/cors';

const app = new Hono();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// Login endpoint using Foreign Data Wrapper
app.post('/make-server-3c4ee602/auth/external-login', async (c) => {
  try {
    const { email, password } = await c.req.json();
    
    console.log('🔐 External login attempt for:', email);
    
    // Query the MySQL database via FDW
    const { data: user, error } = await supabase
      .rpc('authenticate_external_user', {
        p_email: email,
        p_password: password
      });
    
    if (error || !user) {
      console.error('❌ Authentication failed:', error);
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    
    // Generate session token
    const sessionToken = crypto.randomUUID();
    
    // Store session in KV store
    const { error: sessionError } = await supabase
      .from('kv_store_3c4ee602')
      .upsert({
        key: `session:${sessionToken}`,
        value: JSON.stringify({
          userId: user.id,
          email: user.email,
          roles: user.roles,
          permissions: user.permissions,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
        })
      });
    
    if (sessionError) {
      console.error('❌ Session creation failed:', sessionError);
      return c.json({ error: 'Session creation failed' }, 500);
    }
    
    console.log('✅ Login successful for:', email);
    
    return c.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
        permissions: user.permissions
      },
      sessionToken,
      expiresIn: 86400 // 24 hours in seconds
    });
  } catch (error: any) {
    console.error('❌ Login error:', error);
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

// Validate session endpoint
app.get('/make-server-3c4ee602/auth/validate-session', async (c) => {
  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return c.json({ error: 'No token provided' }, 401);
    }
    
    // Get session from KV store
    const { data: sessionData, error } = await supabase
      .from('kv_store_3c4ee602')
      .select('value')
      .eq('key', `session:${token}`)
      .single();
    
    if (error || !sessionData) {
      return c.json({ error: 'Invalid session' }, 401);
    }
    
    const session = JSON.parse(sessionData.value);
    
    // Check if session is expired
    if (new Date(session.expiresAt) < new Date()) {
      // Delete expired session
      await supabase
        .from('kv_store_3c4ee602')
        .delete()
        .eq('key', `session:${token}`);
      
      return c.json({ error: 'Session expired' }, 401);
    }
    
    return c.json({
      valid: true,
      user: {
        id: session.userId,
        email: session.email,
        roles: session.roles,
        permissions: session.permissions
      }
    });
  } catch (error: any) {
    console.error('❌ Session validation error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Check user permission
app.get('/make-server-3c4ee602/auth/check-permission', async (c) => {
  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    const permission = c.req.query('permission');
    
    if (!token || !permission) {
      return c.json({ error: 'Missing token or permission' }, 400);
    }
    
    // Get session
    const { data: sessionData } = await supabase
      .from('kv_store_3c4ee602')
      .select('value')
      .eq('key', `session:${token}`)
      .single();
    
    if (!sessionData) {
      return c.json({ hasPermission: false }, 200);
    }
    
    const session = JSON.parse(sessionData.value);
    
    // Check permission in user's permissions array
    const hasPermission = session.permissions?.some((p: any) => 
      p.name === permission || p.includes(permission)
    ) || false;
    
    return c.json({ hasPermission });
  } catch (error: any) {
    console.error('❌ Permission check error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Check user role
app.get('/make-server-3c4ee602/auth/check-role', async (c) => {
  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    const role = c.req.query('role');
    
    if (!token || !role) {
      return c.json({ error: 'Missing token or role' }, 400);
    }
    
    // Get session
    const { data: sessionData } = await supabase
      .from('kv_store_3c4ee602')
      .select('value')
      .eq('key', `session:${token}`)
      .single();
    
    if (!sessionData) {
      return c.json({ hasRole: false }, 200);
    }
    
    const session = JSON.parse(sessionData.value);
    
    // Check if role exists in user's roles
    const hasRole = session.roles?.includes(role) || false;
    
    return c.json({ hasRole });
  } catch (error: any) {
    console.error('❌ Role check error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Get user by email (for FDW query)
app.get('/make-server-3c4ee602/auth/user/:email', async (c) => {
  try {
    const email = c.params.email;
    
    // Query MySQL via FDW view
    const { data: user, error } = await supabase
      .from('user_with_roles')
      .select('*')
      .eq('email', email)
      .single();
    
    if (error) {
      console.error('❌ User fetch error:', error);
      return c.json({ error: 'User not found' }, 404);
    }
    
    return c.json({ user });
  } catch (error: any) {
    console.error('❌ User fetch error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Logout endpoint
app.post('/make-server-3c4ee602/auth/logout', async (c) => {
  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return c.json({ error: 'No token provided' }, 400);
    }
    
    // Delete session from KV store
    await supabase
      .from('kv_store_3c4ee602')
      .delete()
      .eq('key', `session:${token}`);
    
    return c.json({ success: true, message: 'Logged out successfully' });
  } catch (error: any) {
    console.error('❌ Logout error:', error);
    return c.json({ error: error.message }, 500);
  }
});

export default app;
