# LLM Feature Implementation Summary

## Overview
Added AI-powered Tailwind class editing to the VSCode extension. Users can now use natural language prompts to modify Tailwind classes automatically.

## Changes Made

### 1. Extension Code (`extension.js`)

#### Main Preview Mode (lines 505-700+)
- Added CSS for "Send to LLM" button (purple color, hidden by default)
- Modified editor HTML to include new "Send to LLM" button
- Added button reference (`btnLLM`)
- Implemented `updateLLMButtonVisibility()` to show/hide button when "--" is detected
- Implemented `callLLMToEditClasses()` for OpenRouter API integration
- Implemented `handleLLMEdit()` to process LLM requests
- Added input event listener to detect "--" separator
- Added button click handler for "Send to LLM"
- Modified Enter key handler (`onKey`) to trigger LLM when "--" is present

#### Remote Client Script (Server Preview Mode - lines 1630-1700+)
- Added same CSS for LLM button in remote client styles
- Modified remote editor HTML to include LLM button
- Added button reference and API configuration
- Implemented same LLM functions as main mode (minified for client script)
- Added input listener and button handler
- Modified remote Enter key handler for LLM support

### 2. Configuration
- API Key: Hard-coded (as requested) - `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`
- Model: `openai/gpt-oss-120b`
- Endpoint: `https://openrouter.ai/api/v1/chat/completions`

### 3. Documentation

#### README.md
- Added "AI-Powered Class Editing" to features list
- Added complete "AI-Powered Class Editing" section with:
  - How to use instructions
  - Example prompts
  - Debugging tips
  - Technical details

#### test-llm.html
- Created comprehensive test file with:
  - Multiple test elements with different Tailwind classes
  - Clear instructions for users
  - Example prompts for each element
  - Various element types (cards, buttons, gradients, grids)

## How It Works

### User Flow
1. User double-clicks element in preview
2. Editor popup opens with current classes (original classes saved)
3. User types: `current-classes -- natural language prompt`
4. Purple "Send to LLM" button appears automatically
5. **Changes preview in real-time** - As user types, element updates live
6. User presses Enter or clicks button
7. Button shows "Processing..." state
8. API request sent to OpenRouter
9. Response parsed for `<edited_tw>` tags
10. Input field updated with new classes
11. **Preview updates instantly** showing the LLM-generated changes
12. Button returns to normal state
13. User can:
    - Click "Save" to persist changes to file
    - Click "Cancel" or press Escape to **instantly revert** to original classes

### API Request Format
```
Edit these tailwind classes <tailwind_classes>[classes]</tailwind_classes> 
and return the new, full, edited tailwind, according to the following prompt: 
<user_prompt>[prompt]</user_prompt> 
Return your classes in the format: <edited_tw> updated class list here </edited_tw>
```

### Console Logging
All operations logged with prefix `[TWV LLM]` or `[TWV LLM Remote]`:
- When "--" is detected
- API request start
- Classes and prompts being sent
- Response status
- Raw API response
- Parsed classes
- Any errors with full stack traces

## Testing Instructions

1. Open `test-llm.html` in VS Code
2. Click "Tailwind: Open Preview" button
3. Open browser console (F12) in the preview window
4. Double-click any colored element
5. Try example prompts:
   - `bg-blue-500 text-white p-4 rounded-lg -- make it red`
   - `text-3xl font-bold -- make it smaller and lighter`
6. Watch console for debugging logs
7. Verify classes update correctly
8. Click "Save" to persist changes

## Error Handling

- API failures show alert to user with error message
- All errors logged to console
- Button returns to normal state even on failure
- Fallback to raw content if `<edited_tw>` tags not found
- Validation for empty classes or prompts

## Browser Compatibility

Works in both:
- Main preview mode (webview)
- Server preview mode (iframe with client script)

Uses standard `fetch` API supported in all modern webviews.

## Key Features

✅ **Live preview** - Changes appear in real-time as you type or when LLM updates classes  
✅ **Cancel to undo** - Click Cancel or press Escape to instantly restore original classes  
✅ Works in both regular preview and server preview modes  
✅ Automatic button visibility (shows only when "--" is detected)  
✅ Enter key triggers LLM when "--" is present  
✅ Comprehensive error handling and user feedback  
✅ Extensive console logging for debugging  
✅ Button shows "Processing..." state during API call  
✅ Fallback parsing if expected tags aren't found  
✅ "Save" button persists changes to source file only when you're ready

