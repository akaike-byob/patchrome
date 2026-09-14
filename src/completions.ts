// Printed by `patchrome completions zsh`. Session names and tab ids come from the running daemon as
// you type; with no daemon running they are left out, and completion never starts Chrome.
export const zshCompletionScript = `#compdef patchrome

_patchrome_profile_args() {
  local index=\${words[(i)--profile]}
  (( index < CURRENT )) && print -r -- --profile "\${words[index+1]}"
}

_patchrome_sessions() {
  local -a names
  names=(\${(f)"$(patchrome $(_patchrome_profile_args) sessions 2>/dev/null | awk '$0 != "no sessions" {print $1}')"})
  (( \${#names} )) && _describe -t sessions 'session' names
}

_patchrome_tabs() {
  local -a ids
  patchrome $(_patchrome_profile_args) sessions >/dev/null 2>&1 || return
  ids=(\${(f)"$(patchrome $(_patchrome_profile_args) tabs 2>/dev/null | awk '$2 ~ /^t[0-9]+$/ {print $2 ":" $3}')"})
  (( \${#ids} )) && _describe -t tabs 'tab' ids
}

_patchrome() {
  local -a commands
  commands=(
    'open:new background tab, becomes current'
    'tabs:list your tabs'
    'switch:make a tab current'
    'close:close a tab'
    'goto:navigate the current tab'
    'snapshot:accessibility tree with refs'
    'screenshot:PNG of the current tab'
    'text:visible text'
    'eval:run a JS expression'
    'extract:CSS selectors to JSON rows'
    'wait:block until the page shows a condition'
    'watch:stream page events'
    'click:click a ref or locator'
    'fill:fill a ref or locator'
    'press:press a key'
    'type:type text into the focused element'
    'challenge:detect a CAPTCHA, or hand it to a person'
    'network:list, get or record requests'
    'route:block or mock requests'
    'login:sign in by hand in a visible tab'
    'cookies:list cookies'
    'state:save, load, import or export login state'
    'console:console messages (debug profile)'
    'errors:page errors (debug profile)'
    'trace:record a Playwright trace (debug profile)'
    'cdp:raw CDP call or help (debug profile)'
    'devtools-url:DevTools URL (debug profile)'
    'profile:create a profile'
    'session:show, label or close sessions'
    'sessions:list sessions'
    'daemon:status, stop or logs'
    'audit:recent login copies and their approvals'
    'pipe:run JSON requests from stdin'
    'completions:print a shell completion script'
  )

  local -a locator_args
  locator_args=(
    '--role[ARIA role]:role:(button link textbox checkbox radio combobox option heading listitem row cell tab menuitem dialog img)'
    '--name[accessible name, with --role]:name:'
    '--text[visible text]:text:'
    '--label[form label]:text:'
    '--selector[CSS selector]:css:'
    '--exact[match the whole name or text]'
    '--nth[pick the nth match, from 0]:n:'
    '--frame[iframe CSS selector]:css:'
  )

  _arguments -C \\
    '--profile[browser profile]:profile:' \\
    '--session[session name]:session:_patchrome_sessions' \\
    '--json[print JSON]' \\
    '--timeout-ms[timeout in ms]:ms:' \\
    '1: :->command' \\
    '*:: :->args' && return

  case $state in
    command) _describe -t commands 'patchrome command' commands ;;
    args)
      case $words[1] in
        switch|close) _patchrome_tabs ;;
        sessions) _patchrome_sessions ;;
        session)
          if (( CURRENT == 2 )); then _values 'action' label close history
          elif [[ $words[2] == history ]]; then _arguments '--format[script format]:format:(sh jsonl)' '--out[write to a file]:file:_files'
          elif [[ $words[2] == close ]]; then _patchrome_sessions
          fi
          ;;
        network) (( CURRENT == 2 )) && _values 'action' list get har ;;
        route) (( CURRENT == 2 )) && _values 'action' block mock list clear ;;
        state) (( CURRENT == 2 )) && _values 'action' save load import export ;;
        trace) (( CURRENT == 2 )) && _values 'action' start stop ;;
        daemon) (( CURRENT == 2 )) && _values 'action' status stop logs ;;
        cdp) (( CURRENT == 2 )) && _values 'action' help ;;
        completions) _values 'shell' zsh ;;
        wait) _arguments $locator_args '--url[URL glob]:glob:' '--title[title text]:text:' '--gone[wait for it to go away]' '--load[load state]:state:(load domcontentloaded networkidle)' ;;
        click) _arguments $locator_args '--at[viewport point]:x,y:' ;;
        fill) _arguments $locator_args ;;
        text|screenshot|extract|eval) _arguments $locator_args '--inline[print the value]' '--out[write to a file]:file:_files' ;;
        pipe) _arguments '--bail[stop at the first failure]' ;;
        challenge) _arguments '--handoff[raise the tab and wait for a person]' ;;
        watch) _arguments '--events[event kinds]:events:_values -s , event navigation load response console error' '--url[URL glob]:glob:' '--count[stop after n events]:n:' ;;
      esac
      ;;
  esac
}

compdef _patchrome patchrome
`;
