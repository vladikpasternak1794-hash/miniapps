import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

function verifyTelegramInitData(initData, botToken) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        
        const paramsArray = Array.from(params.entries());
        paramsArray.sort((a, b) => a[0].localeCompare(b[0]));
        const dataCheckString = paramsArray
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData')
            .update(botToken)
            .digest();
        
        const computedHash = crypto.createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');
        
        if (computedHash !== hash) return null;
        
        const authDate = parseInt(params.get('auth_date'));
        const currentTime = Math.floor(Date.now() / 1000);
        if (currentTime - authDate > 86400) return null;
        
        return JSON.parse(params.get('user'));
    } catch (error) {
        return null;
    }
}

async function authMiddleware(req, res, next) {
    try {
        const initData = req.headers['x-telegram-init-data'];
        if (!initData) return res.status(401).json({ error: 'Unauthorized' });
        
        const user = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
        if (!user) return res.status(401).json({ error: 'Invalid' });
        
        const { data: existingUser } = await supabase
            .from('users')
            .select('telegram_id')
            .eq('telegram_id', user.id.toString())
            .single();
        
        if (!existingUser) {
            await supabase.from('users').insert({
                telegram_id: user.id.toString(),
                username: user.username || '',
                first_name: user.first_name || '',
                last_name: user.last_name || ''
            });
        }
        
        req.telegramUser = {
            id: user.id.toString(),
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name
        };
        
        next();
    } catch (error) {
        res.status(500).json({ error: 'Error' });
    }
}

app.get('/api/me', authMiddleware, async (req, res) => {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', req.telegramUser.id)
        .single();
    
    if (error) return res.status(500).json({ error: 'Failed' });
    res.json(data);
});

app.post('/api/events', authMiddleware, async (req, res) => {
    const { event_date, event_time, location, goal, description } = req.body;
    const { data, error } = await supabase
        .from('events')
        .insert({
            created_by: req.telegramUser.id,
            event_date,
            event_time,
            location,
            goal,
            description
        })
        .select()
        .single();
    
    if (error) return res.status(500).json({ error: 'Failed' });
    res.status(201).json(data);
});

app.get('/api/events/month/:year/:month', authMiddleware, async (req, res) => {
    const { year, month } = req.params;
    const startDate = `${year}-${month.padStart(2, '0')}-01`;
    const endDate = `${year}-${month.padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
    
    const { data, error } = await supabase
        .from('events')
        .select('*')
        .gte('event_date', startDate)
        .lte('event_date', endDate)
        .order('event_date', { ascending: true });
    
    if (error) return res.status(500).json({ error: 'Failed' });
    res.json(data);
});

app.post('/api/events/:id/participate', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const { data, error } = await supabase
        .from('event_participants')
        .upsert({
            event_id: id,
            telegram_id: req.telegramUser.id,
            status
        })
        .select()
        .single();
    
    if (error) return res.status(500).json({ error: 'Failed' });
    res.json(data);
});

app.post('/api/votes/:eventId', authMiddleware, async (req, res) => {
    const { eventId } = req.params;
    const { vote_type } = req.body;
    const { data, error } = await supabase
        .from('votes')
        .upsert({
            event_id: eventId,
            telegram_id: req.telegramUser.id,
            vote_type
        })
        .select()
        .single();
    
    if (error) return res.status(500).json({ error: 'Failed' });
    res.json(data);
});

app.get('/api/votes/:eventId', authMiddleware, async (req, res) => {
    const { eventId } = req.params;
    const { data, error } = await supabase
        .from('votes')
        .select('*')
        .eq('event_id', eventId);
    
    if (error) return res.status(500).json({ error: 'Failed' });
    res.json(data);
});

app.post('/api/fundraisings', authMiddleware, async (req, res) => {
    const { event_id, title, description, target_amount } = req.body;
    const { data, error } = await supabase
        .from('fundraisings')
        .insert({
            event_id,
            created_by: req.telegramUser.id,
            title,
            description,
            target_amount,
            current_amount: 0
        })
        .select()
        .single();
    
    if (error) return res.status(500).json({ error: 'Failed' });
    res.status(201).json(data);
});

app.post('/api/fundraisings/:id/contribute', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { amount, is_declined } = req.body;
    const { data, error } = await supabase
        .from('fundraising_contributions')
        .upsert({
            fundraising_id: id,
            telegram_id: req.telegramUser.id,
            amount: amount || 0,
            is_declined: is_declined || false
        })
        .select()
        .single();
    
    if (error) return res.status(500).json({ error: 'Failed' });
    res.json(data);
});

app.get('/api/fundraisings/event/:eventId', authMiddleware, async (req, res) => {
    const { eventId } = req.params;
    const { data, error } = await supabase
        .from('fundraisings')
        .select('*')
        .eq('event_id', eventId);
    
    if (error) return res.status(500).json({ error: 'Failed' });
    res.json(data);
});

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running!' });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
