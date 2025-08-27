const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { body, validationResult } = require('express-validator');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced database connection for production
const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { 
        rejectUnauthorized: false,
        require: true 
    } : false,
    max: isProduction ? 20 : 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true,
    query_timeout: 60000,
    statement_timeout: 60000,
    application_name: 'co2_storage_atlas'
});

// Enhanced connection monitoring
pool.on('connect', (client) => {
    console.log(`✅ Connected to PostgreSQL database (${isProduction ? 'Production' : 'Development'})`);
});

pool.on('error', (err) => {
    console.error('❌ Unexpected database error:', err);
});

// Rate limiting with environment-specific limits
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 1000 : 5000,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false
});

const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 100 : 500,
    message: 'Too many admin requests from this IP, please try again later.'
});

// Enhanced security middleware
app.use(helmet({ 
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:", "https://server.arcgisonline.com", "https://*.tile.openstreetmap.org", "https://*.tile.opentopomap.org"],
            connectSrc: ["'self'", "https://server.arcgisonline.com", "https://*.tile.openstreetmap.org", "https://*.tile.opentopomap.org"],
            fontSrc: ["'self'", "https:", "data:"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

app.use(compression({ 
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));

// Production CORS configuration
const allowedOrigins = isProduction 
    ? [
        /^https:\/\/.*\.onrender\.com$/,
        /^https:\/\/co2-storage-atlas.*\.onrender\.com$/
      ]
    : true;

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(morgan(isProduction ? 'combined' : 'dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(generalLimiter);

// Serve static files with proper headers
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: isProduction ? '1d' : '0',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (path.extname(filePath) === '.html') {
            res.setHeader('Cache-Control', 'no-cache');
        } else if (path.extname(filePath) === '.js' || path.extname(filePath) === '.css') {
            res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
        }
    }
}));

// JWT Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// Enhanced health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        const dbStart = Date.now();
        const result = await pool.query('SELECT NOW() as timestamp, version() as version');
        const dbTime = Date.now() - dbStart;
        
        const dbCheck = await pool.query('SELECT COUNT(*) as table_count FROM information_schema.tables WHERE table_schema = $1', ['public']);
        
        let postgisCheck = null;
        try {
            postgisCheck = await pool.query(`
                SELECT PostGIS_Version() as postgis_version,
                       ST_IsValid(ST_MakePoint(13.5, 47.8)) as geom_test
            `);
        } catch (postgisError) {
            console.warn('PostGIS check failed:', postgisError.message);
        }
        
        res.json({ 
            status: 'OK', 
            timestamp: result.rows[0].timestamp,
            database: {
                status: 'Connected',
                response_time_ms: dbTime,
                tables: parseInt(dbCheck.rows[0].table_count),
                version: result.rows[0].version.split(' ')[0] + ' ' + result.rows[0].version.split(' ')[1]
            },
            postgis: {
                available: !!postgisCheck,
                version: postgisCheck ? postgisCheck.rows[0].postgis_version : 'Not available',
                geometry_test: postgisCheck ? postgisCheck.rows[0].geom_test : false
            },
            environment: process.env.NODE_ENV || 'development',
            uptime: process.uptime(),
            memory: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
                total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
            }
        });
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(503).json({ 
            status: 'ERROR', 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ========================================
// AUTHENTICATION ENDPOINTS
// ========================================

app.post('/api/auth/login', [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { username, password } = req.body;
        
        // Environment-based admin authentication for initial setup
        if (username === 'admin' && password === process.env.ADMIN_PASSWORD) {
            const token = jwt.sign(
                { id: 1, username: 'admin', role: 'admin' },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
            );

            return res.json({ 
                token, 
                user: { id: 1, username: 'admin', role: 'admin' }
            });
        }

        // Database authentication
        try {
            const result = await pool.query(
                'SELECT id, username, password_hash, is_active FROM admin_users WHERE username = $1',
                [username]
            );

            if (result.rows.length === 0 || !result.rows[0].is_active) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const user = result.rows[0];
            const isValidPassword = await bcrypt.compare(password, user.password_hash);

            if (!isValidPassword) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            await pool.query(
                'UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
                [user.id]
            );

            const token = jwt.sign(
                { id: user.id, username: user.username, role: 'admin' },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
            );

            res.json({ 
                token, 
                user: { id: user.id, username: user.username, role: 'admin' }
            });
        } catch (dbError) {
            console.warn('Database authentication failed, using environment auth:', dbError.message);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// ========================================
// DATA RETRIEVAL ENDPOINTS
// ========================================

// Helper function to check if table exists
const tableExists = async (tableName) => {
    try {
        const result = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = $1
            );
        `, [tableName]);
        return result.rows[0].exists;
    } catch (error) {
        console.error(`Error checking table ${tableName}:`, error);
        return false;
    }
};

// CO2 Sources with enhanced performance
app.get('/api/co2-sources-enhanced', async (req, res) => {
    try {
        if (!(await tableExists('co2_sources'))) {
            return res.json([]);
        }

        const { bbox, zoom } = req.query;
        let query = `
            SELECT id, plant_name, plant_type, total_co2_t, fossil_co2_t,
                   biogenic_co2_t, comment, is_prominent, pin_size, pin_color,
                   ST_X(geom) as longitude, ST_Y(geom) as latitude,
                   ST_IsValid(geom) as geom_valid
            FROM co2_sources
            WHERE geom IS NOT NULL
        `;
        
        const params = [];
        
        if (bbox) {
            const [minLng, minLat, maxLng, maxLat] = bbox.split(',').map(Number);
            if (!isNaN(minLng) && !isNaN(minLat) && !isNaN(maxLng) && !isNaN(maxLat)) {
                query += ` AND geom && ST_MakeEnvelope($${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4}, 4326)`;
                params.push(minLng, minLat, maxLng, maxLat);
            }
        }
        
        query += ` ORDER BY is_prominent DESC NULLS LAST, total_co2_t DESC NULLS LAST`;
        
        if (zoom && parseInt(zoom) < 10) {
            query += ` LIMIT 1000`;
        } else {
            query += ` LIMIT 5000`;
        }
        
        const result = await pool.query(query, params);
        console.log(`Retrieved ${result.rows.length} CO2 sources`);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching CO2 sources:', error);
        res.json([]);
    }
});

// Voting districts with enhanced error handling
app.get('/api/voting-districts-choropleth', async (req, res) => {
    try {
        if (!(await tableExists('voting_districts'))) {
            return res.json([]);
        }

        const { simplify } = req.query;
        const tolerance = simplify === 'true' ? 0.001 : 0;
        
        const query = `
            SELECT vd.id, vd.gkz, vd.name, 
                   vd.spo_percent, vd.ovp_percent, vd.fpo_percent,
                   vd.grune_percent, vd.kpo_percent, vd.neos_percent,
                   vd.left_green_combined, 
                   COALESCE(vd.choropleth_color, '#cccccc') as fill_color,
                   ${tolerance > 0 
                     ? `ST_AsGeoJSON(ST_Simplify(ST_Transform(vd.geom, 4326), ${tolerance}))` 
                     : 'ST_AsGeoJSON(ST_Transform(vd.geom, 4326))'
                   } as geometry,
                   ST_X(ST_Transform(ST_Centroid(vd.geom), 4326)) as center_lng,
                   ST_Y(ST_Transform(ST_Centroid(vd.geom), 4326)) as center_lat,
                   ST_IsValid(vd.geom) as geom_valid,
                   (vd.spo_percent > 0 OR vd.ovp_percent > 0 OR vd.fpo_percent > 0 OR 
                    vd.grune_percent > 0 OR vd.kpo_percent > 0 OR vd.neos_percent > 0) as has_voting_data
            FROM voting_districts vd
            WHERE vd.geom IS NOT NULL AND ST_IsValid(vd.geom) = true
            ORDER BY vd.left_green_combined DESC NULLS LAST
            LIMIT 1000
        `;
        
        const result = await pool.query(query);
        console.log(`Retrieved ${result.rows.length} voting districts`);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching voting districts:', error);
        res.json([]);
    }
});

// Generic endpoint creator for point layers
const createPointLayerEndpoint = (tableName, fields, orderBy = 'id') => {
    return async (req, res) => {
        try {
            if (!(await tableExists(tableName))) {
                return res.json([]);
            }

            const { bbox, zoom } = req.query;
            let query = `
                SELECT ${fields.join(', ')},
                       ST_X(ST_Transform(geom, 4326)) as longitude, 
                       ST_Y(ST_Transform(geom, 4326)) as latitude,
                       ST_IsValid(geom) as geom_valid
                FROM ${tableName}
                WHERE geom IS NOT NULL AND ST_IsValid(geom) = true
            `;
            
            const params = [];
            
            if (bbox) {
                const [minLng, minLat, maxLng, maxLat] = bbox.split(',').map(Number);
                if (!isNaN(minLng) && !isNaN(minLat) && !isNaN(maxLng) && !isNaN(maxLat)) {
                    query += ` AND geom && ST_Transform(ST_MakeEnvelope($${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4}, 4326), ST_SRID(geom))`;
                    params.push(minLng, minLat, maxLng, maxLat);
                }
            }
            
            query += ` ORDER BY ${orderBy} LIMIT 2000`;
            
            const result = await pool.query(query, params);
            console.log(`Retrieved ${result.rows.length} ${tableName.replace('_', ' ')}`);
            res.json(result.rows);
        } catch (error) {
            console.error(`Error fetching ${tableName}:`, error);
            res.json([]);
        }
    };
};

// Point-based layer endpoints
app.get('/api/landfills-enhanced', createPointLayerEndpoint('landfills', [
    'id', 'company_name', 'location_name', 'district', 'address', 'facility_type',
    'COALESCE(pin_size, 2) as pin_size', 
    'COALESCE(pin_color, \'#ff8800\') as pin_color',
    'COALESCE(opacity, 0.8) as opacity'
]));

app.get('/api/gravel-pits-enhanced', createPointLayerEndpoint('gravel_pits', [
    'id', 'name', 'resource', 'tags',
    'COALESCE(pin_size, 2) as pin_size', 
    'COALESCE(pin_color, \'#8855aa\') as pin_color',
    'COALESCE(opacity, 0.7) as opacity'
]));

app.get('/api/wastewater-plants-enhanced', createPointLayerEndpoint('wastewater_plants', [
    'id', 'pk', 'label', 'treatment_type', 'capacity',
    'COALESCE(pin_size, 2) as pin_size', 
    'COALESCE(pin_color, \'#3388ff\') as pin_color',
    'COALESCE(opacity, 0.6) as opacity'
]));

app.get('/api/gas-storage-sites-enhanced', createPointLayerEndpoint('gas_storage_sites', [
    'id', 'name', 'operator', 'storage_type', 'capacity_bcm',
    'COALESCE(pin_size, 2) as pin_size', 
    'COALESCE(pin_color, \'#00cc88\') as pin_color',
    'COALESCE(opacity, 0.5) as opacity'
]));

app.get('/api/gas-distribution-points-enhanced', createPointLayerEndpoint('gas_distribution_points', [
    'id', 'name', 'type', 'operator',
    'COALESCE(pin_size, 1) as pin_size', 
    'COALESCE(pin_color, \'#00aa44\') as pin_color',
    'COALESCE(opacity, 0.4) as opacity'
]));

app.get('/api/compressor-stations-enhanced', createPointLayerEndpoint('compressor_stations', [
    'id', 'name', 'operator', 'capacity_info',
    'COALESCE(pin_size, 2) as pin_size', 
    'COALESCE(pin_color, \'#ffaa00\') as pin_color',
    'COALESCE(opacity, 0.3) as opacity'
]));

// Generic endpoint creator for line layers
const createLineLayerEndpoint = (tableName, fields) => {
    return async (req, res) => {
        try {
            if (!(await tableExists(tableName))) {
                return res.json([]);
            }

            const { bbox, simplify } = req.query;
            const tolerance = simplify === 'true' ? 0.001 : 0;
            
            let geomField = 'geom';
            if (tolerance > 0) {
                geomField = `ST_Simplify(geom, ${tolerance})`;
            }
            
            let query = `
                SELECT ${fields.join(', ')},
                       ST_AsGeoJSON(ST_Transform(${geomField}, 4326)) as geometry,
                       ST_IsValid(geom) as geom_valid
                FROM ${tableName}
                WHERE geom IS NOT NULL AND ST_IsValid(geom) = true
            `;
            
            const params = [];
            
            if (bbox) {
                const [minLng, minLat, maxLng, maxLat] = bbox.split(',').map(Number);
                if (!isNaN(minLng) && !isNaN(minLat) && !isNaN(maxLng) && !isNaN(maxLat)) {
                    query += ` AND geom && ST_Transform(ST_MakeEnvelope($${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4}, 4326), ST_SRID(geom))`;
                    params.push(minLng, minLat, maxLng, maxLat);
                }
            }
            
            query += ` LIMIT 1000`;
            
            const result = await pool.query(query, params);
            console.log(`Retrieved ${result.rows.length} ${tableName.replace('_', ' ')}`);
            res.json(result.rows);
        } catch (error) {
            console.error(`Error fetching ${tableName}:`, error);
            res.json([]);
        }
    };
};

// Line-based layer endpoints
app.get('/api/gas-pipelines-enhanced', createLineLayerEndpoint('gas_pipelines', [
    'id', 'name', 'operator', 'diameter', 'pressure_level', 'pipeline_type',
    'COALESCE(line_color, \'#00aa44\') as line_color', 
    'COALESCE(line_weight, 4) as line_weight', 
    'COALESCE(line_opacity, 0.8) as line_opacity'
]));

app.get('/api/highways', createLineLayerEndpoint('highways', [
    'id', 'name', 'highway_number', 'road_type',
    'COALESCE(line_color, \'#666666\') as line_color', 
    'COALESCE(line_weight, 3) as line_weight', 
    'COALESCE(line_opacity, 0.7) as line_opacity'
]));

app.get('/api/railways', createLineLayerEndpoint('railways', [
    'id', 'name', 'railway_type', 'operator',
    'COALESCE(line_color, \'#8B4513\') as line_color', 
    'COALESCE(line_weight, 3) as line_weight', 
    'COALESCE(line_opacity, 0.8) as line_opacity'
]));

// Generic endpoint creator for polygon layers
const createPolygonLayerEndpoint = (tableName, fields) => {
    return async (req, res) => {
        try {
            if (!(await tableExists(tableName))) {
                return res.json([]);
            }

            const { bbox, simplify } = req.query;
            const tolerance = simplify === 'true' ? 0.002 : 0;
            
            let geomField = 'geom';
            if (tolerance > 0) {
                geomField = `ST_Simplify(geom, ${tolerance})`;
            }
            
            let query = `
                SELECT ${fields.join(', ')},
                       ST_AsGeoJSON(ST_Transform(${geomField}, 4326)) as geometry,
                       ST_IsValid(geom) as geom_valid
                FROM ${tableName}
                WHERE geom IS NOT NULL AND ST_IsValid(geom) = true
            `;
            
            const params = [];
            
            if (bbox) {
                const [minLng, minLat, maxLng, maxLat] = bbox.split(',').map(Number);
                if (!isNaN(minLng) && !isNaN(minLat) && !isNaN(maxLng) && !isNaN(maxLat)) {
                    query += ` AND geom && ST_Transform(ST_MakeEnvelope($${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4}, 4326), ST_SRID(geom))`;
                    params.push(minLng, minLat, maxLng, maxLat);
                }
            }
            
            query += ` LIMIT 500`;
            
            const result = await pool.query(query, params);
            console.log(`Retrieved ${result.rows.length} ${tableName.replace('_', ' ')}`);
            res.json(result.rows);
        } catch (error) {
            console.error(`Error fetching ${tableName}:`, error);
            res.json([]);
        }
    };
};

// Polygon-based layer endpoints
app.get('/api/groundwater-protection', createPolygonLayerEndpoint('groundwater_protection', [
    'id', 'name', 'protection_zone',
    'COALESCE(fill_color, \'#0066ff\') as fill_color', 
    'COALESCE(fill_opacity, 0.3) as fill_opacity', 
    'COALESCE(border_color, \'#0044cc\') as border_color', 
    'COALESCE(border_weight, 2) as border_weight'
]));

app.get('/api/conservation-areas', createPolygonLayerEndpoint('conservation_areas', [
    'id', 'name', 'protection_level', 'area_type',
    'COALESCE(fill_color, \'#00ff00\') as fill_color', 
    'COALESCE(fill_opacity, 0.3) as fill_opacity', 
    'COALESCE(border_color, \'#00cc00\') as border_color', 
    'COALESCE(border_weight, 2) as border_weight'
]));

app.get('/api/settlement-areas', createPolygonLayerEndpoint('settlement_areas', [
    'id', 'name', 'area_type', 'population',
    'COALESCE(fill_color, \'#ff0000\') as fill_color', 
    'COALESCE(fill_opacity, 0.3) as fill_opacity', 
    'COALESCE(border_color, \'#cc0000\') as border_color', 
    'COALESCE(border_weight, 2) as border_weight'
]));

// Database stats endpoint
app.get('/api/database-stats', async (req, res) => {
    try {
        const tables = [
            'co2_sources', 'voting_districts', 'landfills', 'gravel_pits',
            'wastewater_plants', 'gas_pipelines', 'gas_storage_sites',
            'gas_distribution_points', 'compressor_stations',
            'groundwater_protection', 'conservation_areas', 'settlement_areas',
            'highways', 'railways'
        ];
        
        const stats = {};
        for (const table of tables) {
            try {
                if (await tableExists(table)) {
                    const countResult = await pool.query(`SELECT COUNT(*) as count FROM ${table}`);
                    const validGeomResult = await pool.query(`SELECT COUNT(*) as count FROM ${table} WHERE geom IS NOT NULL AND ST_IsValid(geom) = true`);
                    stats[table] = {
                        total: parseInt(countResult.rows[0].count),
                        validGeometry: parseInt(validGeomResult.rows[0].count)
                    };
                } else {
                    stats[table] = { total: 0, validGeometry: 0, note: 'Table not found' };
                }
            } catch (error) {
                stats[table] = { total: 0, validGeometry: 0, error: error.message };
            }
        }
        
        res.json(stats);
    } catch (error) {
        console.error('Error fetching database stats:', error);
        res.status(500).json({ 
            error: 'Failed to fetch database statistics',
            details: error.message 
        });
    }
});

// Layer styles endpoint
app.get('/api/layer-styles', async (req, res) => {
    try {
        if (await tableExists('layer_styles')) {
            const query = 'SELECT * FROM layer_styles WHERE is_active = true';
            const result = await pool.query(query);
            res.json(result.rows);
        } else {
            // Return default styles if table doesn't exist
            res.json([]);
        }
    } catch (error) {
        console.error('Error fetching layer styles:', error);
        res.json([]);
    }
});

// ========================================
// ADMIN ENDPOINTS
// ========================================

// Admin-only database setup endpoint
app.post('/api/admin/setup-database', adminLimiter, authenticateToken, async (req, res) => {
    try {
        const results = [];
        
        // Enable PostGIS extension
        try {
            await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
            results.push('PostGIS extension enabled');
        } catch (error) {
            results.push(`PostGIS warning: ${error.message}`);
        }

        // Create basic tables
        const createQueries = [
            `CREATE TABLE IF NOT EXISTS co2_sources (
                id SERIAL PRIMARY KEY,
                plant_name VARCHAR(255) NOT NULL,
                plant_type VARCHAR(100),
                total_co2_t NUMERIC(12,2) DEFAULT 0,
                fossil_co2_t NUMERIC(12,2) DEFAULT 0,
                biogenic_co2_t NUMERIC(12,2) DEFAULT 0,
                comment TEXT,
                is_prominent BOOLEAN DEFAULT FALSE,
                pin_size INTEGER DEFAULT 2,
                pin_color VARCHAR(7) DEFAULT '#ff4444',
                geom GEOMETRY(POINT, 4326),
                properties JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            
            `CREATE TABLE IF NOT EXISTS voting_districts (
                id SERIAL PRIMARY KEY,
                gkz INTEGER UNIQUE,
                name VARCHAR(255),
                spo_percent NUMERIC(5,2) DEFAULT 0,
                ovp_percent NUMERIC(5,2) DEFAULT 0,
                fpo_percent NUMERIC(5,2) DEFAULT 0,
                grune_percent NUMERIC(5,2) DEFAULT 0,
                kpo_percent NUMERIC(5,2) DEFAULT 0,
                neos_percent NUMERIC(5,2) DEFAULT 0,
                left_green_combined NUMERIC(5,2) DEFAULT 0,
                choropleth_color VARCHAR(7),
                geom GEOMETRY(MULTIPOLYGON, 4326),
                center_point GEOMETRY(POINT, 4326),
                properties JSONB,
                has_voting_data BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`
        ];

        for (const query of createQueries) {
            await pool.query(query);
        }
        results.push('Basic tables created successfully');

        // Create spatial indexes
        const indexQueries = [
            'CREATE INDEX IF NOT EXISTS idx_co2_sources_geom ON co2_sources USING GIST (geom)',
            'CREATE INDEX IF NOT EXISTS idx_voting_districts_geom ON voting_districts USING GIST (geom)',
            'CREATE INDEX IF NOT EXISTS idx_co2_sources_prominent ON co2_sources(is_prominent, total_co2_t DESC)',
            'CREATE INDEX IF NOT EXISTS idx_voting_districts_gkz ON voting_districts(gkz)'
        ];

        for (const query of indexQueries) {
            try {
                await pool.query(query);
            } catch (error) {
                results.push(`Index warning: ${error.message}`);
            }
        }
        results.push('Spatial indexes created');

        res.json({ 
            message: 'Database setup completed',
            results: results
        });
    } catch (error) {
        console.error('Database setup error:', error);
        res.status(500).json({ 
            error: 'Failed to setup database',
            details: error.message
        });
    }
});

// Data import trigger (placeholder for actual import)
app.post('/api/admin/import-data', adminLimiter, authenticateToken, async (req, res) => {
    try {
        res.json({ 
            message: 'Data import functionality available via server-side scripts',
            status: 'info',
            timestamp: new Date().toISOString(),
            note: 'Use `npm run import` on server to import data from files'
        });
    } catch (error) {
        console.error('Import endpoint error:', error);
        res.status(500).json({ error: 'Import endpoint error' });
    }
});

// Root route serves the main application
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all handler for SPA routing
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'API endpoint not found' });
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// Enhanced global error handler
app.use((error, req, res, next) => {
    console.error('Unhandled error:', {
        error: error.message,
        stack: isProduction ? undefined : error.stack,
        url: req.url,
        method: req.method,
        timestamp: new Date().toISOString()
    });
    
    res.status(500).json({
        error: 'Internal server error',
        message: isProduction ? 'Something went wrong' : error.message,
        timestamp: new Date().toISOString()
    });
});

// Enhanced process error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (isProduction) {
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (isProduction) {
        process.exit(1);
    }
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    
    pool.end(() => {
        console.log('Database pool closed');
        process.exit(0);
    });
    
    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
        console.error('Forced exit after 10s timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 CO₂ Storage Atlas Server Started
========================================
Environment: ${process.env.NODE_ENV || 'development'}
Port: ${PORT}
Database: ${process.env.DATABASE_URL ? 'Configured' : 'Not configured'}
PostGIS: Will be checked on first request
Security: ${isProduction ? 'Production mode' : 'Development mode'}
========================================
🌍 Application ready at: http://localhost:${PORT}
📊 Health check: http://localhost:${PORT}/api/health
🔐 Admin login: ${process.env.ADMIN_PASSWORD ? 'Configured' : 'Using default'}
========================================
    `);
});

module.exports = app;
