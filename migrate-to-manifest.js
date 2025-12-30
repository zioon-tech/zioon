#!/usr/bin/env node

/**
 * 批量迁移插件从 extension.json 到 manifest.json
 */

import fs from 'fs';
import path from 'path';

const EXTENSIONS_DIR = './extensions';

function migrateExtensionToManifest(extensionJson) {
  const manifest = {
    name: extensionJson.name,
    version: extensionJson.version,
    description: extensionJson.description || `Zion Next Plugin: ${extensionJson.name}`,
    author: extensionJson.author || 'Zion Developer',
    license: extensionJson.license || 'MIT',
    zion: {
      id: extensionJson.name,
      name: extensionJson.name,
      version: extensionJson.version,
      main: extensionJson.main,
      contributes: extensionJson.contributes || {},
      activationEvents: extensionJson.activationEvents || [],
      engines: {
        zion: '>=1.0.0'
      }
    }
  };

  return manifest;
}

function main() {
  console.log('Starting migration from extension.json to manifest.json...\n');

  const extensions = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  const results = {
    migrated: [],
    skipped: [],
    errors: []
  };

  for (const extName of extensions) {
    const extPath = path.join(EXTENSIONS_DIR, extName);
    const extJsonPath = path.join(extPath, 'extension.json');
    const manifestJsonPath = path.join(extPath, 'manifest.json');

    // 跳过没有 extension.json 的目录
    if (!fs.existsSync(extJsonPath)) {
      console.log(`⏭️  Skipping ${extName} (no extension.json)`);
      results.skipped.push(extName);
      continue;
    }

    // 如果已经有 manifest.json，跳过
    if (fs.existsSync(manifestJsonPath)) {
      console.log(`⏭️  Skipping ${extName} (manifest.json already exists)`);
      results.skipped.push(extName);
      continue;
    }

    try {
      // 读取 extension.json
      const extensionJson = JSON.parse(fs.readFileSync(extJsonPath, 'utf8'));

      // 转换为 manifest.json
      const manifestJson = migrateExtensionToManifest(extensionJson);

      // 写入 manifest.json
      fs.writeFileSync(
        manifestJsonPath,
        JSON.stringify(manifestJson, null, 2),
        'utf8'
      );

      console.log(`✅ Migrated ${extName}`);
      results.migrated.push(extName);
    } catch (error) {
      console.error(`❌ Error migrating ${extName}:`, error.message);
      results.errors.push({ name: extName, error: error.message });
    }
  }

  // 打印总结
  console.log('\n========================================');
  console.log('Migration Summary:');
  console.log('========================================');
  console.log(`✅ Migrated: ${results.migrated.length}`);
  console.log(`⏭️  Skipped: ${results.skipped.length}`);
  console.log(`❌ Errors:   ${results.errors.length}`);

  if (results.migrated.length > 0) {
    console.log('\nMigrated plugins:');
    results.migrated.forEach(name => console.log(`  - ${name}`));
  }

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    results.errors.forEach(({ name, error }) => {
      console.log(`  - ${name}: ${error}`);
    });
    process.exit(1);
  }

  console.log('\n✨ Migration completed successfully!');
  console.log('\nNext steps:');
  console.log('1. Review the generated manifest.json files');
  console.log('2. Test the application: npm run dev');
  console.log('3. If everything works, delete old extension.json files:');
  console.log(`   find ${EXTENSIONS_DIR} -name "extension.json" -delete`);
}

main();
