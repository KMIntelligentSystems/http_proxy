 Yes. Your OpenRouter key in .env can fit cleanly into the long-term pi-mono web-ui architecture, but the key point is:                                                                                                                          

 │ If the web UI is backed by a server-side Pi runtime, OpenRouter model registration should happen server-side, not in the browser.

 That keeps the OpenRouter key out of browser IndexedDB/localStorage and lets the web UI simply display/select server-registered models.

 ────────────────────────────────────────────────────────────────────────────────

 1. How Pi registers custom models today

 Pi supports custom model providers through:                                                                                                                                                                                                     

 ```text
   ~/.pi/agent/models.json                                                                                                                                                                                                                       
 ```

 The docs support OpenRouter-style OpenAI-compatible providers:

 ```json
   {
     "providers": {
       "openrouter": {
         "baseUrl": "https://openrouter.ai/api/v1",
         "apiKey": "OPENROUTER_API_KEY",
         "api": "openai-completions",
         "models": [                                                                                                                                                                                                                             
           {
             "id": "anthropic/claude-3.5-sonnet",                                                                                                                                                                                                
             "name": "Claude 3.5 Sonnet via OpenRouter",                                                                                                                                                                                         
             "reasoning": false,                                                                                                                                                                                                                 
             "input": ["text"],
             "contextWindow": 200000,                                                                                                                                                                                                            
             "maxTokens": 8192                                                                                                                                                                                                                   
           }
         ]
       }
     }
   }
 ```

 The important field is:

 ```json
   "apiKey": "OPENROUTER_API_KEY"
 ```

 That means Pi looks for an environment variable named:

 ```text
   OPENROUTER_API_KEY                                                                                                                                                                                                                            
 ```

 So if your .env contains:

 ```env
   OPENROUTER_API_KEY=sk-or-v1-...
 ```

 then Pi can use it if that .env file is loaded into process.env before the model registry is created.

 ────────────────────────────────────────────────────────────────────────────────

 2. Current issue: .env is not automatically loaded by Pi

 Pi’s models.json can reference environment variables, but Node does not automatically load .env.

 Right now this project manually reads data/.env in src/host.ts for the BLS key:

 ```ts
   const envPath = path.resolve(import.meta.dirname ?? ".", "..", "data", ".env");
   const envText = fs.readFileSync(envPath, "utf-8");
   const match = envText.match(/^BLS_API_KEY=(.+)$/m);
 ```

 That only loads BLS_API_KEY for host.ts.

 It does not globally populate:                                                                                                                                                                                                                  

 ```ts
   process.env.OPENROUTER_API_KEY                                                                                                                                                                                                                
 ```

 for Pi’s model registry.

 So we need a shared .env loading step in the future web-main process.                                                                                                                                                                           

 ────────────────────────────────────────────────────────────────────────────────

 3. Recommended approach

 Add OpenRouter to Pi’s model registry server-side.

 There are three viable ways.

 ────────────────────────────────────────────────────────────────────────────────

 Option A — Use ~/.pi/agent/models.json

 This is closest to how Pi expects custom models to be configured.

 Create or edit:

 ```text
   ~/.pi/agent/models.json
 ```

 Example:

 ```json
   {
     "providers": {
       "openrouter": {
         "baseUrl": "https://openrouter.ai/api/v1",
         "apiKey": "OPENROUTER_API_KEY",
         "api": "openai-completions",
         "authHeader": true,
         "headers": {                                                                                                                                                                                                                            
           "HTTP-Referer": "http://localhost:8080",                                                                                                                                                                                              
           "X-Title": "Data Visualization Agent"
         },
         "models": [
           {
             "id": "anthropic/claude-3.5-sonnet",                                                                                                                                                                                                
             "name": "Claude 3.5 Sonnet via OpenRouter",                                                                                                                                                                                         
             "reasoning": false,
             "input": ["text"],
             "contextWindow": 200000,
             "maxTokens": 8192                                                                                                                                                                                                                   
           },
           {
             "id": "openai/gpt-4o-mini",
             "name": "GPT-4o Mini via OpenRouter",                                                                                                                                                                                               
             "reasoning": false,
             "input": ["text", "image"],                                                                                                                                                                                                         
             "contextWindow": 128000,
             "maxTokens": 16384
           },
           {
             "id": "google/gemini-2.5-pro",
             "name": "Gemini 2.5 Pro via OpenRouter",
             "reasoning": true,
             "input": ["text", "image"],                                                                                                                                                                                                         
             "contextWindow": 1000000,
             "maxTokens": 65536                                                                                                                                                                                                                  
           }
         ]
       }
     }
   }
 ```

 Then make sure .env is loaded before creating the runtime.

 This is clean because Pi’s existing /model logic and model registry already understand models.json.

 ────────────────────────────────────────────────────────────────────────────────

 Option B — Register OpenRouter through a Pi extension

 Pi extensions can register providers dynamically:

 ```ts
   pi.registerProvider("openrouter", {
     baseUrl: "https://openrouter.ai/api/v1",
     apiKey: "OPENROUTER_API_KEY",
     api: "openai-completions",
     authHeader: true,                                                                                                                                                                                                                           
     headers: {
       "HTTP-Referer": "http://localhost:8080",                                                                                                                                                                                                  
       "X-Title": "Data Visualization Agent"
     },
     models: [
       {
         id: "anthropic/claude-3.5-sonnet",
         name: "Claude 3.5 Sonnet via OpenRouter",
         reasoning: false,                                                                                                                                                                                                                       
         input: ["text"],
         contextWindow: 200000,
         maxTokens: 8192                                                                                                                                                                                                                         
       }
     ]
   });
 ```

 File:

 ```text
   .pi/extensions/openrouter/index.ts                                                                                                                                                                                                            
 ```

 This keeps OpenRouter registration project-local.

 Pros:
 - Project-specific.
 - Version-controlled.
 - Can register curated model list.
 - Can later fetch OpenRouter models dynamically.

 Cons:
 - Still needs .env loaded into process.env.

 ────────────────────────────────────────────────────────────────────────────────

 Option C — Host-managed OpenRouter model registry

 Long-term, for the web UI, this may be the best UX.                                                                                                                                                                                             

 Host adds:

 ```text
   GET /ui/api/models
   POST /ui/api/agent/model
   POST /ui/api/models/openrouter/refresh                                                                                                                                                                                                        
 ```

 The host can:

 1. Read OPENROUTER_API_KEY.
 2. Fetch available models from OpenRouter.
 3. Filter to approved models.
 4. Register or expose those models to the web UI.
 5. Let the user choose one from the browser UI.

 This is more work, but it gives the best browser experience.

 ────────────────────────────────────────────────────────────────────────────────

 4. Where .env loading should happen                                                                                                                                                                                                             

 For the future web-primary architecture, add a shared environment loader.                                                                                                                                                                       

 Example:

 ```text
   src/env.ts
 ```                                                                                                                                                                                                                                             
                                                                                                                                                                                                                                                 
 ```ts                                                                                                                                                                                                                                           
   import fs from "node:fs";
   import path from "node:path";

   export function loadProjectEnv(cwd = process.cwd()) {                                                                                                                                                                                         
     const candidates = [
       path.join(cwd, ".env"),
       path.join(cwd, "data", ".env")
     ];

     for (const file of candidates) {                                                                                                                                                                                                            
       if (!fs.existsSync(file)) continue;                                                                                                                                                                                                       

       const text = fs.readFileSync(file, "utf-8");

       for (const line of text.split(/\r?\n/)) {                                                                                                                                                                                                 
         const trimmed = line.trim();
         if (!trimmed || trimmed.startsWith("#")) continue;

         const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);                                                                                                                                                                         
         if (!match) continue;                                                                                                                                                                                                                   

         const key = match[1];                                                                                                                                                                                                                   
         let value = match[2].trim();

         value = value.replace(/^["']|["']$/g, "");                                                                                                                                                                                              

         if (!process.env[key]) {                                                                                                                                                                                                                
           process.env[key] = value;
         }
       }
     }
   }
 ```

 Then call it at the very top of future:                                                                                                                                                                                                         

 ```ts
   src/web-main.ts
 ```

 and probably also current:

 ```ts
   src/cli.ts
 ```

 Before this:                                                                                                                                                                                                                                    

 ```ts
   const runtime = await createAgentSessionRuntime(...)                                                                                                                                                                                          
 ```

 Example:

 ```ts                                                                                                                                                                                                                                           
   import { loadProjectEnv } from "./env.js";

   loadProjectEnv(process.cwd());

   // now create MCP tools, AuthStorage, ModelRegistry, runtime, etc.
 ```

 That makes this work:

 ```json
   "apiKey": "OPENROUTER_API_KEY"
 ```

 because process.env.OPENROUTER_API_KEY exists before Pi resolves the key.

 ────────────────────────────────────────────────────────────────────────────────

 5. How this maps to pi-mono web-ui

 There are two different cases.

 ────────────────────────────────────────────────────────────────────────────────

 Case 1 — Browser-side Agent

 This is how the pi-mono example works.

 The browser creates:                                                                                                                                                                                                                            

 ```ts
   const agent = new Agent({                                                                                                                                                                                                                          initialState: {
       model: getModel(...),                                                                                                                                                                                                                     
       systemPrompt: "...",                                                                                                                                                                                                                      
       messages: [],                                                                                                                                                                                                                             
       tools: []
     }
   });
 ```

 In that case, the browser would need the OpenRouter key.

 I do not recommend this for your long-term architecture.

 Why?

 - The OpenRouter key would live in browser storage.
 - Browser-side agent would not naturally use the project’s delegate extension.                                                                                                                                                                  
 - Browser-side agent would not naturally use local filesystem/data tools.                                                                                                                                                                       
 - It diverges from Pi’s existing coding-agent runtime.

 ────────────────────────────────────────────────────────────────────────────────

 Case 2 — Server-side AgentSessionRuntime

 This is the recommended architecture.

 The server owns:

 ```text
   OpenRouter key                                                                                                                                                                                                                                
   model registry
   AgentSessionRuntime                                                                                                                                                                                                                           
   delegate extension                                                                                                                                                                                                                            
   tools
   data APIs
   artifact generation
 ```

 The browser owns:

 ```text
   pi-web-ui rendering
   prompt input
   model picker UI
   artifact display
 ```

 So model selection becomes:

 ```text
   Browser model selector
     ↓
   POST /ui/api/agent/model
     ↓
   host updates runtime/session model                                                                                                                                                                                                            
     ↓                                                                                                                                                                                                                                           
   host broadcasts state update
     ↓
   pi-web-ui updates display
 ```
                                                                                                                                                                                                                                                 
 The OpenRouter key never leaves the server.

 ────────────────────────────────────────────────────────────────────────────────

 6. Model selection in the web UI                                                                                                                                                                                                                

 pi-web-ui has its own model selector in the browser-oriented example, but for our backend-owned runtime we probably need a custom model-selection bridge.                                                                                       

 Host routes:

 ```text
   GET /ui/api/models
   POST /ui/api/agent/model
 ```

 Example response from:                                                                                                                                                                                                                          

 ```text
   GET /ui/api/models
 ```

 ```json
   {
     "current": {                                                                                                                                                                                                                                
       "provider": "openrouter",                                                                                                                                                                                                                 
       "id": "anthropic/claude-3.5-sonnet",
       "name": "Claude 3.5 Sonnet via OpenRouter"
     },
     "models": [
       {
         "provider": "openrouter",
         "id": "anthropic/claude-3.5-sonnet",
         "name": "Claude 3.5 Sonnet via OpenRouter",
         "contextWindow": 200000,
         "input": ["text"]
       },
       {
         "provider": "openrouter",
         "id": "openai/gpt-4o-mini",
         "name": "GPT-4o Mini via OpenRouter",                                                                                                                                                                                                   
         "contextWindow": 128000,
         "input": ["text", "image"]
       }
     ]
   }
 ```

 Browser sends:

 ```http
   POST /ui/api/agent/model                                                                                                                                                                                                                      
   Content-Type: application/json

   {
     "provider": "openrouter",
     "id": "anthropic/claude-3.5-sonnet",
     "thinkingLevel": "off"
   }
 ```

 Server does something conceptually like:                                                                                                                                                                                                        

 ```ts
   const model = modelRegistry.find(provider, id);
   runtime.session.agent.setModel(model);                                                                                                                                                                                                        
   runtime.session.agent.setThinkingLevel(thinkingLevel);                                                                                                                                                                                        
 ```

 Exact method names may vary, but conceptually the server updates the active agent state.

 ────────────────────────────────────────────────────────────────────────────────

 7. Recommended OpenRouter configuration strategy                                                                                                                                                                                                

 I would use a curated model list first.

 Do not expose every OpenRouter model immediately.

 OpenRouter has many models with different:

 - tool support
 - context windows
 - costs
 - vision support
 - reasoning behavior
 - streaming quirks
 - provider routing quirks                                                                                                                                                                                                                       

 For this project, start with maybe 3–6 known-good models:

 ```json
   {
     "providers": {
       "openrouter": {
         "baseUrl": "https://openrouter.ai/api/v1",
         "apiKey": "OPENROUTER_API_KEY",
         "api": "openai-completions",
         "authHeader": true,                                                                                                                                                                                                                     
         "headers": {
           "HTTP-Referer": "http://localhost:8080",
           "X-Title": "Data Visualization Agent"                                                                                                                                                                                                 
         },
         "models": [
           {                                                                                                                                                                                                                                     
             "id": "anthropic/claude-3.5-sonnet",
             "name": "Claude 3.5 Sonnet via OpenRouter",
             "reasoning": false,
             "input": ["text"],
             "contextWindow": 200000,
             "maxTokens": 8192
           },
           {
             "id": "openai/gpt-4o-mini",
             "name": "GPT-4o Mini via OpenRouter",                                                                                                                                                                                               
             "reasoning": false,
             "input": ["text", "image"],
             "contextWindow": 128000,                                                                                                                                                                                                            
             "maxTokens": 16384                                                                                                                                                                                                                  
           },
           {
             "id": "google/gemini-2.5-pro",
             "name": "Gemini 2.5 Pro via OpenRouter",                                                                                                                                                                                            
             "reasoning": true,
             "input": ["text", "image"],
             "contextWindow": 1000000,
             "maxTokens": 65536
           }
         ]
       }
     }
   }
 ```

 Then later add a “refresh from OpenRouter” feature.

 ────────────────────────────────────────────────────────────────────────────────

 8. How this affects cli.ts and future web-main.ts

 Current cli.ts should eventually get:                                                                                                                                                                                                           

 ```ts
   loadProjectEnv(process.cwd());
 ```

 near the top.

 Future web-main.ts definitely needs it:                                                                                                                                                                                                         
                                                                                                                                                                                                                                                 
 ```ts                                                                                                                                                                                                                                           
   import { loadProjectEnv } from "./env.js";

   loadProjectEnv(process.cwd());                                                                                                                                                                                                                

   const runtime = await createAgentSessionRuntime(...);
 ```

 That way:

 ```text
   .env → process.env.OPENROUTER_API_KEY → Pi model registry → OpenRouter provider                                                                                                                                                               
 ```

 ────────────────────────────────────────────────────────────────────────────────

 9. Recommended concrete plan

 Short term

 1. Add OPENROUTER_API_KEY to .env:

 ```env
   OPENROUTER_API_KEY=sk-or-v1-...
 ```

 2. Add OpenRouter provider to:

 ```text
   ~/.pi/agent/models.json
 ```

 or project extension:                                                                                                                                                                                                                           

 ```text
   .pi/extensions/openrouter/index.ts
 ```

 3. Add shared env loading to src/cli.ts.

 Then current TUI can use OpenRouter models through Pi’s existing model registry.

 ────────────────────────────────────────────────────────────────────────────────

 Medium term

 When building src/web-main.ts:

 1. Load .env.                                                                                                                                                                                                                                   
 2. Create server-side runtime.
 3. Expose:

 ```text
   GET /ui/api/models
   POST /ui/api/agent/model
 ```

 4. Make pi-web-ui model selector use those endpoints rather than browser-local keys.

 ────────────────────────────────────────────────────────────────────────────────

 Long term

 Add:

 ```text
   POST /ui/api/models/openrouter/refresh                                                                                                                                                                                                        
 ```

 Host fetches OpenRouter’s model list, filters it, and makes approved models available in the web UI.                                                                                                                                            

 But keep the API key server-side.

 ────────────────────────────────────────────────────────────────────────────────

 Bottom line

 Your OpenRouter key should be incorporated as a server-side provider registration.

 Best path:

 ```text
   .env
     OPENROUTER_API_KEY=...                                                                                                                                                                                                                      
         ↓
   loadProjectEnv()
         ↓
   ~/.pi/agent/models.json or pi.registerProvider("openrouter", ...)
         ↓
   server-side AgentSessionRuntime
         ↓
   browser pi-web-ui model picker
 ```

 For the long-term pi-mono web UI, the browser should select models, but the server should own the OpenRouter key and actual provider/model registry.   