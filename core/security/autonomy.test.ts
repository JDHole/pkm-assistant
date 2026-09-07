import test from 'ava';
import {
    AUTONOMY_MODES,
    DEFAULT_AUTONOMY,
    SAFE_PERMISSION_TYPES,
    TOOL_RISK_LEVELS,
    classifyToolRisk,
    isEdgePermissionType,
    normalizeAutonomy,
} from './autonomy.js';
import { PERMISSION_TYPES } from './PermissionSystem.js';

test('AUTONOMY_MODES: dokładnie yolo/edge/all', t => {
    t.deepEqual(AUTONOMY_MODES, ['yolo', 'edge', 'all']);
});

test('DEFAULT_AUTONOMY: edge (pytaj-na-krawędzi)', t => {
    t.is(DEFAULT_AUTONOMY, 'edge');
    t.true(AUTONOMY_MODES.includes(DEFAULT_AUTONOMY));
});

test('SAFE_PERMISSION_TYPES: tylko read_notes i thinking', t => {
    t.true(SAFE_PERMISSION_TYPES.has(PERMISSION_TYPES.READ_NOTES));
    t.true(SAFE_PERMISSION_TYPES.has(PERMISSION_TYPES.THINKING));
    t.is(SAFE_PERMISSION_TYPES.size, 2);
    // Krawędziowe kategorie NIE są bezpieczne:
    t.false(SAFE_PERMISSION_TYPES.has(PERMISSION_TYPES.EDIT_NOTES));
    t.false(SAFE_PERMISSION_TYPES.has(PERMISSION_TYPES.MCP));
});

test('isEdgePermissionType: read/think = NIE krawędź', t => {
    t.false(isEdgePermissionType(PERMISSION_TYPES.READ_NOTES));
    t.false(isEdgePermissionType(PERMISSION_TYPES.THINKING));
});

// Fix znaleziska TS-1 #1: 5 asercji na kategoriach skasowanych w E2.8 A5 (EXECUTE_COMMANDS,
// BUILDING_AGENTS, ACCESS_OUTSIDE_VAULT, SYSTEM_SETTINGS, SKILLS_CRUD) realnie sprawdzało
// `isEdgePermissionType(undefined)` — gałąź fail-closed ma własny test niżej, więc wyleciały.
test('isEdgePermissionType: zapis/kasowanie/web/mcp = krawędź', t => {
    t.true(isEdgePermissionType(PERMISSION_TYPES.EDIT_NOTES));
    t.true(isEdgePermissionType(PERMISSION_TYPES.CREATE_FILES));
    t.true(isEdgePermissionType(PERMISSION_TYPES.DELETE_FILES));
    t.true(isEdgePermissionType(PERMISSION_TYPES.WEB_SEARCH));
    t.true(isEdgePermissionType(PERMISSION_TYPES.MCP));
});

test('isEdgePermissionType: FAIL-CLOSED — nieznane/brak = krawędź', t => {
    t.true(isEdgePermissionType(undefined));
    t.true(isEdgePermissionType(null));
    t.true(isEdgePermissionType(''));
    t.true(isEdgePermissionType('jakies_przyszle_uprawnienie'));
});

test('normalizeAutonomy: prawidłowe tryby przechodzą bez zmian', t => {
    t.is(normalizeAutonomy('yolo'), 'yolo');
    t.is(normalizeAutonomy('edge'), 'edge');
    t.is(normalizeAutonomy('all'), 'all');
});

test('normalizeAutonomy: nieznane/brak → DEFAULT_AUTONOMY (edge)', t => {
    t.is(normalizeAutonomy(undefined), 'edge');
    t.is(normalizeAutonomy(null), 'edge');
    t.is(normalizeAutonomy(''), 'edge');
    t.is(normalizeAutonomy('cokolwiek'), 'edge');
    t.is(normalizeAutonomy('YOLO'), 'edge'); // case-sensitive — wielkie litery to nie tryb
    t.is(normalizeAutonomy(42), 'edge');
});

test('A3 traffic lights: read=green, create=yellow, overwrite/delete=red', t => {
    t.is(classifyToolRisk({
        action: 'vault.read',
        permissionType: PERMISSION_TYPES.READ_NOTES,
        toolName: 'read',
    }), TOOL_RISK_LEVELS.GREEN);
    t.is(classifyToolRisk({
        action: 'vault.write',
        permissionType: PERMISSION_TYPES.EDIT_NOTES,
        toolName: 'write',
        operationMode: 'create',
    }), TOOL_RISK_LEVELS.YELLOW);
    t.is(classifyToolRisk({
        action: 'vault.write',
        permissionType: PERMISSION_TYPES.EDIT_NOTES,
        toolName: 'write',
        operationMode: 'patch',
    }), TOOL_RISK_LEVELS.RED);
    t.is(classifyToolRisk({
        action: 'vault.delete',
        permissionType: PERMISSION_TYPES.DELETE_FILES,
        toolName: 'delete',
    }), TOOL_RISK_LEVELS.RED);
});

test('A3 traffic lights: external tool and unknown tool fail closed to red', t => {
    t.is(classifyToolRisk({
        action: 'vault.read',
        permissionType: PERMISSION_TYPES.READ_NOTES,
        toolName: 'friendly_external_read',
        isExternalTool: true,
    }), TOOL_RISK_LEVELS.RED);
    t.is(classifyToolRisk({ toolName: 'future_tool' }), TOOL_RISK_LEVELS.RED);
});

test('A3 traffic lights: todo read=green, todo mutation=yellow', t => {
    t.is(classifyToolRisk({ toolName: 'todo', operationMode: 'get' }), TOOL_RISK_LEVELS.GREEN);
    t.is(classifyToolRisk({ toolName: 'todo', operationMode: 'add' }), TOOL_RISK_LEVELS.YELLOW);
});

test('A3 traffic lights (S28): kom_send=yellow mimo akcji agent.message, odczyt skrzynki=green', t => {
    // Jawny wyjątek narzędziowy MUSI wyprzedzić szeroką regułę `action === 'agent.message'`.
    t.is(classifyToolRisk({
        action: 'agent.message',
        permissionType: PERMISSION_TYPES.EDIT_NOTES,
        toolName: 'kom_send',
    }), TOOL_RISK_LEVELS.YELLOW);
    t.is(classifyToolRisk({ action: 'vault.read', toolName: 'kom_list' }), TOOL_RISK_LEVELS.GREEN);
    t.is(classifyToolRisk({ action: 'vault.read', toolName: 'kom_read' }), TOOL_RISK_LEVELS.GREEN);
    // Nierozpoznane narzędzie deklarujące wysyłkę do agenta dalej fail-closed na czerwono.
    t.is(classifyToolRisk({ action: 'agent.message', toolName: 'kom_send_v2' }), TOOL_RISK_LEVELS.RED);
    // Zewnętrzny serwer wygrywa nad wyjątkiem — cudzy kod zawsze RED.
    t.is(classifyToolRisk({ toolName: 'kom_send', isExternalTool: true }), TOOL_RISK_LEVELS.RED);
});
