# Selection toolbar and layer visibility evidence

Static public chunk1833 (`1833-29e749719b751fa6.js`).

The only quoted translation references190/191/192/193 are in component iC near byte450270. That component consumes updateTriggerKeyRangeValue, triggerMode, getDefaultTriggerInfo and editDeadzone and implements WASD, Select All, Invert, Deselect for actuation/trigger editing. Its only JSX invocation near byte468900 is guarded by currentTab===trigger. KeyCode and AdvancedKey use component ix instead. Therefore these named bulk-selection buttons are not established missing G75 mechanical remap controls; prior PARITY row inferred their scope from translations too broadly.

Component ix near byte441599 provides Win/WinFn/Mac/MacFn layer buttons and Restore All, using resetAllKeys and language181 for keyCode /182 for advancedKey. Its disabled predicate for advancedKey explicitly disables odd-index layers and switching away during active advanced edits. The app currently allows advanced targeting all four layers; preserve other layers in transport, but compare the UI target restrictions separately before claiming1:1 advanced navigation.

This evidence does not settle drag-select, per-key context copy/paste/cut, or lighting-selection workflows. Inspect those actual handlers instead of extending the trigger-only toolbar into remapping.
