const { Client } = require('pg');
require('dotenv').config();

class ProductionDatabaseSetup {
    constructor() {
        // Use DATABASE_URL for production compatibility
        this.client = new Client({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { 
                rejectUnauthorized: false 
            } : false
        });
    }

    async setup() {
        try {
            console.log('🚀 Starting production database setup...\n');
            
            await this.client.connect();
            console.log('✅ Connected to PostgreSQL database');
            
            await this.setupPostGIS();
            await this.createTables();
            await this.createIndexes();
            await this.insertDefaultData();
            await this.createFunctions();
            
            console.log('\n🎉 Database setup completed successfully!');
            console.log('📊 Database is ready for CO₂ Storage Atlas');
            
        } catch (error) {
            console.error('❌ Database setup failed:', error);
            process.exit(1);
        } finally {
            await this.client.end();
        }
    }

    async setupPostGIS() {
        try {
            await this.client.query('CREATE EXTENSION IF NOT EXISTS postgis');
            console.log('✅ PostGIS extension enabled');
            
            // Verify PostGIS installation
            const sridCheck = await this.client.query(`
                SELECT srid, proj4text FROM spatial_ref_sys WHERE srid = 4326
            `);
            
            if (sridCheck.rows.length > 0) {
                console.log('✅ EPSG:4326 (WGS84) coordinate system verified');
            } else {
                console.warn('⚠️  EPSG:4326 not found in spatial_ref_sys');
            }
            
        } catch (error) {
            console.warn('⚠️  PostGIS setup warning:', error.message);
        }
    }

    async createTables() {
        const tables = [
            {
                name: 'study_area_boundaries',
                query: `
                    CREATE TABLE IF NOT EXISTS study_area_boundaries (
                        id SERIAL PRIMARY KEY,
                        g_id VARCHAR(50) UNIQUE,
                        g_name VARCHAR(255),
                        state VARCHAR(100),
                        geom GEOMETRY(MULTIPOLYGON, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'co2_sources',
                query: `
                    CREATE TABLE IF NOT EXISTS co2_sources (
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
                        icon_url VARCHAR(500),
                        opacity NUMERIC(3,2) DEFAULT 1.0,
                        geom GEOMETRY(POINT, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'voting_districts',
                query: `
                    CREATE TABLE IF NOT EXISTS voting_districts (
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
                        geometry_valid BOOLEAN DEFAULT FALSE,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'landfills',
                query: `
                    CREATE TABLE IF NOT EXISTS landfills (
                        id SERIAL PRIMARY KEY,
                        company_name VARCHAR(255),
                        location_name VARCHAR(255),
                        district VARCHAR(100),
                        address VARCHAR(500),
                        facility_type VARCHAR(255),
                        pin_size INTEGER DEFAULT 2,
                        pin_color VARCHAR(7) DEFAULT '#ff8800',
                        icon_url VARCHAR(500),
                        opacity NUMERIC(3,2) DEFAULT 0.8,
                        geom GEOMETRY(POINT, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'gravel_pits',
                query: `
                    CREATE TABLE IF NOT EXISTS gravel_pits (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(255),
                        resource VARCHAR(255),
                        tags TEXT,
                        pin_size INTEGER DEFAULT 2,
                        pin_color VARCHAR(7) DEFAULT '#8855aa',
                        icon_url VARCHAR(500),
                        opacity NUMERIC(3,2) DEFAULT 0.7,
                        geom GEOMETRY(POINT, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'wastewater_plants',
                query: `
                    CREATE TABLE IF NOT EXISTS wastewater_plants (
                        id SERIAL PRIMARY KEY,
                        pk VARCHAR(50),
                        label VARCHAR(255),
                        treatment_type VARCHAR(100),
                        capacity INTEGER,
                        pin_size INTEGER DEFAULT 2,
                        pin_color VARCHAR(7) DEFAULT '#3388ff',
                        icon_url VARCHAR(500),
                        opacity NUMERIC(3,2) DEFAULT 0.6,
                        geom GEOMETRY(POINT, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'gas_pipelines',
                query: `
                    CREATE TABLE IF NOT EXISTS gas_pipelines (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(255),
                        operator VARCHAR(255),
                        diameter INTEGER,
                        pressure_level VARCHAR(50),
                        pipeline_type VARCHAR(100),
                        line_color VARCHAR(7) DEFAULT '#00aa44',
                        line_weight INTEGER DEFAULT 4,
                        line_opacity NUMERIC(3,2) DEFAULT 0.8,
                        geom GEOMETRY(MULTILINESTRING, 4326),
                        simplified_geom GEOMETRY(MULTILINESTRING, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'gas_storage_sites',
                query: `
                    CREATE TABLE IF NOT EXISTS gas_storage_sites (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(255),
                        operator VARCHAR(255),
                        storage_type VARCHAR(100),
                        capacity_bcm NUMERIC(10,3),
                        pin_size INTEGER DEFAULT 2,
                        pin_color VARCHAR(7) DEFAULT '#00cc88',
                        icon_url VARCHAR(500),
                        opacity NUMERIC(3,2) DEFAULT 0.5,
                        geom GEOMETRY(POINT, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'gas_distribution_points',
                query: `
                    CREATE TABLE IF NOT EXISTS gas_distribution_points (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(255),
                        type VARCHAR(100),
                        operator VARCHAR(255),
                        pin_size INTEGER DEFAULT 1,
                        pin_color VARCHAR(7) DEFAULT '#00aa44',
                        icon_url VARCHAR(500),
                        opacity NUMERIC(3,2) DEFAULT 0.4,
                        geom GEOMETRY(POINT, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'compressor_stations',
                query: `
                    CREATE TABLE IF NOT EXISTS compressor_stations (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(255),
                        operator VARCHAR(255),
                        capacity_info TEXT,
                        pin_size INTEGER DEFAULT 2,
                        pin_color VARCHAR(7) DEFAULT '#ffaa00',
                        icon_url VARCHAR(500),
                        opacity NUMERIC(3,2) DEFAULT 0.3,
                        geom GEOMETRY(POINT, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'groundwater_protection',
                query: `
                    CREATE TABLE IF NOT EXISTS groundwater_protection (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(255),
                        protection_zone VARCHAR(50),
                        fill_color VARCHAR(7) DEFAULT '#0066ff',
                        fill_opacity NUMERIC(3,2) DEFAULT 0.3,
                        border_color VARCHAR(7) DEFAULT '#0044cc',
                        border_weight INTEGER DEFAULT 2,
                        geom GEOMETRY(MULTIPOLYGON, 4326),
                        simplified_geom GEOMETRY(MULTIPOLYGON, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'conservation_areas',
                query: `
                    CREATE TABLE IF NOT EXISTS conservation_areas (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(255),
                        protection_level VARCHAR(100),
                        area_type VARCHAR(100),
                        fill_color VARCHAR(7) DEFAULT '#00ff00',
                        fill_opacity NUMERIC(3,2) DEFAULT 0.3,
                        border_color VARCHAR(7) DEFAULT '#00cc00',
                        border_weight INTEGER DEFAULT 2,
                        geom GEOMETRY(MULTIPOLYGON, 4326),
                        simplified_geom GEOMETRY(MULTIPOLYGON, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'settlement_areas',
                query: `
                    CREATE TABLE IF NOT EXISTS settlement_areas (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(255),
                        area_type VARCHAR(50),
                        population INTEGER,
                        fill_color VARCHAR(7) DEFAULT '#ff0000',
                        fill_opacity NUMERIC(3,2) DEFAULT 0.3,
                        border_color VARCHAR(7) DEFAULT '#cc0000',
                        border_weight INTEGER DEFAULT 2,
                        geom GEOMETRY(MULTIPOLYGON, 4326),
                        simplified_geom GEOMETRY(MULTIPOLYGON, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'highways',
                query: `
                    CREATE TABLE IF NOT EXISTS highways (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(255),
                        highway_number VARCHAR(50),
                        road_type VARCHAR(50),
                        line_color VARCHAR(7) DEFAULT '#666666',
                        line_weight INTEGER DEFAULT 3,
                        line_opacity NUMERIC(3,2) DEFAULT 0.7,
                        geom GEOMETRY(MULTILINESTRING, 4326),
                        simplified_geom GEOMETRY(MULTILINESTRING, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'railways',
                query: `
                    CREATE TABLE IF NOT EXISTS railways (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(255),
                        railway_type VARCHAR(50),
                        operator VARCHAR(255),
                        line_color VARCHAR(7) DEFAULT '#8B4513',
                        line_weight INTEGER DEFAULT 3,
                        line_opacity NUMERIC(3,2) DEFAULT 0.8,
                        geom GEOMETRY(MULTILINESTRING, 4326),
                        simplified_geom GEOMETRY(MULTILINESTRING, 4326),
                        properties JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'layer_styles',
                query: `
                    CREATE TABLE IF NOT EXISTS layer_styles (
                        id SERIAL PRIMARY KEY,
                        layer_name VARCHAR(100) UNIQUE,
                        style_config JSONB,
                        is_active BOOLEAN DEFAULT TRUE,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'admin_users',
                query: `
                    CREATE TABLE IF NOT EXISTS admin_users (
                        id SERIAL PRIMARY KEY,
                        username VARCHAR(50) UNIQUE NOT NULL,
                        email VARCHAR(255) UNIQUE,
                        password_hash VARCHAR(255) NOT NULL,
                        is_active BOOLEAN DEFAULT TRUE,
                        last_login TIMESTAMP,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            },
            {
                name: 'audit_log',
                query: `
                    CREATE TABLE IF NOT EXISTS audit_log (
                        id SERIAL PRIMARY KEY,
                        table_name VARCHAR(100),
                        record_id INTEGER,
                        action VARCHAR(10),
                        old_values JSONB,
                        new_values JSONB,
                        user_id INTEGER REFERENCES admin_users(id),
                        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `
            }
        ];

        console.log('📋 Creating database tables...');
        for (const table of tables) {
            try {
                await this.client.query(table.query);
                console.log(`✅ Table '${table.name}' created/verified`);
            } catch (error) {
                console.error(`❌ Error creating table ${table.name}:`, error.message);
                throw error;
            }
        }
    }

    async createIndexes() {
        const indexes = [
            // Spatial indexes
            { name: 'idx_study_area_geom', query: 'CREATE INDEX IF NOT EXISTS idx_study_area_geom ON study_area_boundaries USING GIST (geom)' },
            { name: 'idx_co2_sources_geom', query: 'CREATE INDEX IF NOT EXISTS idx_co2_sources_geom ON co2_sources USING GIST (geom)' },
            { name: 'idx_voting_districts_geom', query: 'CREATE INDEX IF NOT EXISTS idx_voting_districts_geom ON voting_districts USING GIST (geom)' },
            { name: 'idx_landfills_geom', query: 'CREATE INDEX IF NOT EXISTS idx_landfills_geom ON landfills USING GIST (geom)' },
            { name: 'idx_gravel_pits_geom', query: 'CREATE INDEX IF NOT EXISTS idx_gravel_pits_geom ON gravel_pits USING GIST (geom)' },
            { name: 'idx_wastewater_plants_geom', query: 'CREATE INDEX IF NOT EXISTS idx_wastewater_plants_geom ON wastewater_plants USING GIST (geom)' },
            { name: 'idx_gas_pipelines_geom', query: 'CREATE INDEX IF NOT EXISTS idx_gas_pipelines_geom ON gas_pipelines USING GIST (geom)' },
            { name: 'idx_gas_storage_sites_geom', query: 'CREATE INDEX IF NOT EXISTS idx_gas_storage_sites_geom ON gas_storage_sites USING GIST (geom)' },
            { name: 'idx_gas_distribution_points_geom', query: 'CREATE INDEX IF NOT EXISTS idx_gas_distribution_points_geom ON gas_distribution_points USING GIST (geom)' },
            { name: 'idx_compressor_stations_geom', query: 'CREATE INDEX IF NOT EXISTS idx_compressor_stations_geom ON compressor_stations USING GIST (geom)' },
            { name: 'idx_groundwater_protection_geom', query: 'CREATE INDEX IF NOT EXISTS idx_groundwater_protection_geom ON groundwater_protection USING GIST (geom)' },
            { name: 'idx_conservation_areas_geom', query: 'CREATE INDEX IF NOT EXISTS idx_conservation_areas_geom ON conservation_areas USING GIST (geom)' },
            { name: 'idx_settlement_areas_geom', query: 'CREATE INDEX IF NOT EXISTS idx_settlement_areas_geom ON settlement_areas USING GIST (geom)' },
            { name: 'idx_highways_geom', query: 'CREATE INDEX IF NOT EXISTS idx_highways_geom ON highways USING GIST (geom)' },
            { name: 'idx_railways_geom', query: 'CREATE INDEX IF NOT EXISTS idx_railways_geom ON railways USING GIST (geom)' },
            
            // Performance indexes
            { name: 'idx_co2_sources_prominent', query: 'CREATE INDEX IF NOT EXISTS idx_co2_sources_prominent ON co2_sources(is_prominent, total_co2_t DESC)' },
            { name: 'idx_voting_districts_gkz', query: 'CREATE INDEX IF NOT EXISTS idx_voting_districts_gkz ON voting_districts(gkz)' },
            { name: 'idx_voting_districts_valid', query: 'CREATE INDEX IF NOT EXISTS idx_voting_districts_valid ON voting_districts(geometry_valid)' },
            { name: 'idx_voting_left_green', query: 'CREATE INDEX IF NOT EXISTS idx_voting_left_green ON voting_districts(left_green_combined DESC)' },
            { name: 'idx_co2_sources_type', query: 'CREATE INDEX IF NOT EXISTS idx_co2_sources_type ON co2_sources(plant_type)' },
            { name: 'idx_layer_styles_name', query: 'CREATE INDEX IF NOT EXISTS idx_layer_styles_name ON layer_styles(layer_name)' },
            { name: 'idx_admin_users_username', query: 'CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username)' },
            { name: 'idx_audit_log_table', query: 'CREATE INDEX IF NOT EXISTS idx_audit_log_table ON audit_log(table_name, record_id)' }
        ];

        console.log('📊 Creating indexes...');
        let created = 0;
        for (const index of indexes) {
            try {
                await this.client.query(index.query);
                created++;
            } catch (error) {
                console.warn(`⚠️  Index ${index.name} warning:`, error.message);
            }
        }
        console.log(`✅ Created/verified ${created} indexes`);
    }

    async insertDefaultData() {
        console.log('📝 Inserting default configuration data...');
        
        // Insert default layer styles
        const styles = [
            { name: 'co2_sources', config: { default_color: '#ff4444', prominent_color: '#cc0000', icon_path: '/icons/CO₂ Sources.png', cluster_enabled: true } },
            { name: 'voting_districts', config: { opacity: 0.4, border_color: '#ffffff', choropleth: true } },
            { name: 'landfills', config: { default_color: '#ff8800', icon_path: '/icons/Landfills.png', cluster_enabled: true } },
            { name: 'gravel_pits', config: { default_color: '#8855aa', icon_path: '/icons/Gravel Pits.png', cluster_enabled: true } },
            { name: 'wastewater_plants', config: { default_color: '#3388ff', icon_path: '/icons/Wastewater Plants.png', cluster_enabled: true } },
            { name: 'gas_storage_sites', config: { default_color: '#00cc88', icon_path: '/icons/Gas Storage.png', cluster_enabled: true } },
            { name: 'gas_distribution_points', config: { default_color: '#00aa44', icon_path: '/icons/Gas Distribution.png', cluster_enabled: true } },
            { name: 'compressor_stations', config: { default_color: '#ffaa00', icon_path: '/icons/Compressor Stations.png', cluster_enabled: true } },
            { name: 'gas_pipelines', config: { default_color: '#00aa44', weight: 4, opacity: 0.8 } },
            { name: 'groundwater_protection', config: { fill_color: '#0066ff', fill_opacity: 0.3, border_color: '#0044cc' } },
            { name: 'conservation_areas', config: { fill_color: '#00ff00', fill_opacity: 0.3, border_color: '#00cc00' } },
            { name: 'settlement_areas', config: { fill_color: '#ff0000', fill_opacity: 0.3, border_color: '#cc0000' } },
            { name: 'highways', config: { default_color: '#666666', weight: 3, opacity: 0.7 } },
            { name: 'railways', config: { default_color: '#8B4513', weight: 3, opacity: 0.8, dash_array: '10,5' } }
        ];

        let stylesAdded = 0;
        for (const style of styles) {
            try {
                await this.client.query(
                    'INSERT INTO layer_styles (layer_name, style_config) VALUES ($1, $2) ON CONFLICT (layer_name) DO UPDATE SET style_config = EXCLUDED.style_config',
                    [style.name, JSON.stringify(style.config)]
                );
                stylesAdded++;
            } catch (error) {
                console.warn(`Style for ${style.name} error:`, error.message);
            }
        }
        console.log(`✅ Added/updated ${stylesAdded} layer styles`);

        // Create default admin user if password is provided
        if (process.env.ADMIN_PASSWORD) {
            try {
                const bcrypt = require('bcryptjs');
                const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
                
                await this.client.query(
                    'INSERT INTO admin_users (username, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash',
                    ['admin', process.env.ADMIN_EMAIL || 'admin@co2atlas.local', passwordHash]
                );
                console.log('✅ Default admin user created/updated');
            } catch (error) {
                console.warn('Admin user creation warning:', error.message);
            }
        }
    }

    async createFunctions() {
        console.log('🔧 Creating utility functions...');
        
        const functions = [
            {
                name: 'update_geometry_validity',
                query: `
                    CREATE OR REPLACE FUNCTION update_geometry_validity()
                    RETURNS VOID AS $$
                    BEGIN
                        UPDATE voting_districts 
                        SET geometry_valid = (geom IS NOT NULL AND ST_IsValid(geom));
                        
                        UPDATE voting_districts
                        SET has_voting_data = (
                            spo_percent > 0 OR ovp_percent > 0 OR fpo_percent > 0 OR 
                            grune_percent > 0 OR kpo_percent > 0 OR neos_percent > 0
                        );
                    END;
                    $$ LANGUAGE plpgsql;
                `
            },
            {
                name: 'create_simplified_geometries',
                query: `
                    CREATE OR REPLACE FUNCTION create_simplified_geometries()
                    RETURNS VOID AS $$
                    BEGIN
                        UPDATE gas_pipelines 
                        SET simplified_geom = ST_Simplify(geom, 0.001)
                        WHERE geom IS NOT NULL;
                        
                        UPDATE groundwater_protection 
                        SET simplified_geom = ST_Simplify(geom, 0.001)
                        WHERE geom IS NOT NULL;
                        
                        UPDATE conservation_areas 
                        SET simplified_geom = ST_Simplify(geom, 0.001)
                        WHERE geom IS NOT NULL;
                        
                        UPDATE settlement_areas 
                        SET simplified_geom = ST_Simplify(geom, 0.001)
                        WHERE geom IS NOT NULL;
                        
                        UPDATE highways 
                        SET simplified_geom = ST_Simplify(geom, 0.001)
                        WHERE geom IS NOT NULL;
                        
                        UPDATE railways 
                        SET simplified_geom = ST_Simplify(geom, 0.001)
                        WHERE geom IS NOT NULL;
                    END;
                    $$ LANGUAGE plpgsql;
                `
            },
            {
                name: 'update_updated_at_column',
                query: `
                    CREATE OR REPLACE FUNCTION update_updated_at_column()
                    RETURNS TRIGGER AS $$
                    BEGIN
                        NEW.updated_at = CURRENT_TIMESTAMP;
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql;
                `
            }
        ];

        for (const func of functions) {
            try {
                await this.client.query(func.query);
                console.log(`✅ Function '${func.name}' created`);
            } catch (error) {
                console.warn(`Function ${func.name} warning:`, error.message);
            }
        }

        // Create triggers for updated_at columns
        const tables = [
            'co2_sources', 'voting_districts', 'landfills', 'gravel_pits',
            'wastewater_plants', 'gas_pipelines', 'gas_storage_sites',
            'gas_distribution_points', 'compressor_stations', 'study_area_boundaries',
            'groundwater_protection', 'conservation_areas', 'settlement_areas',
            'highways', 'railways', 'layer_styles', 'admin_users'
        ];

        for (const table of tables) {
            try {
                await this.client.query(`
                    CREATE TRIGGER update_${table}_updated_at 
                    BEFORE UPDATE ON ${table}
                    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
                `);
            } catch (error) {
                // Trigger might already exist, ignore
            }
        }

        console.log('✅ Triggers created for updated_at columns');
    }
}

// Run setup if called directly
if (require.main === module) {
    const setup = new ProductionDatabaseSetup();
    setup.setup();
}

module.exports = ProductionDatabaseSetup;
