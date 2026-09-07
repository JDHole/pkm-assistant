import test from 'ava';
import { deriveDelegateCategory, getCategoryColor } from './category_colors.js';
import { IconGenerator } from './IconGenerator.js';
import { CrystalGenerator } from './CrystalGenerator.js';

test('category colors fall back to general', t => {
    t.is(getCategoryColor('missing'), getCategoryColor('general'));
});

test('deriveDelegateCategory detects planning tools', t => {
    t.is(deriveDelegateCategory(['todo', 'artifact_create']), 'planning');
});

test('IconGenerator falls back for unknown category', t => {
    const svg = IconGenerator.generate('x', 'unknown-category');
    t.true(svg.startsWith('<svg'));
});

test('CrystalGenerator exposes shape names for generated seeds', t => {
    t.true(CrystalGenerator.SHAPES.includes(CrystalGenerator.getShapeName('Jaskier')));
});
