// Top stories on Hacker News from Go, over one `patchrome pipe`. Run with `go run .`.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
)

type response struct {
	ID     int             `json:"id"`
	OK     bool            `json:"ok"`
	Data   json.RawMessage `json:"data"`
	Stream json.RawMessage `json:"stream"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type patchrome struct {
	stdin  io.WriteCloser
	stdout *bufio.Scanner
	nextID int
	cmd    *exec.Cmd
}

func start(session string) (*patchrome, error) {
	cmd := exec.Command("patchrome", "pipe")
	cmd.Env = append(os.Environ(), "PATCHROME_SESSION="+session)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	return &patchrome{stdin: stdin, stdout: scanner, cmd: cmd}, cmd.Start()
}

// run sends the words you would type after `patchrome` and decodes the response's data into out.
func (p *patchrome) run(out any, words ...string) error {
	p.nextID++
	request, _ := json.Marshal(map[string]any{"id": p.nextID, "argv": words})
	if _, err := fmt.Fprintf(p.stdin, "%s\n", request); err != nil {
		return err
	}
	for p.stdout.Scan() {
		var message response
		if err := json.Unmarshal(p.stdout.Bytes(), &message); err != nil {
			return err
		}
		if message.ID != p.nextID || message.Stream != nil {
			continue
		}
		if !message.OK {
			return fmt.Errorf("patchrome %s: %s", message.Error.Code, message.Error.Message)
		}
		if out == nil {
			return nil
		}
		return json.Unmarshal(message.Data, out)
	}
	return fmt.Errorf("patchrome pipe exited: %v", p.stdout.Err())
}

func (p *patchrome) close() {
	_ = p.run(nil, "session", "close")
	_ = p.stdin.Close()
	_ = p.cmd.Wait()
}

func main() {
	browser, err := start(fmt.Sprintf("hn-go-%d", os.Getpid()))
	if err != nil {
		log.Fatal(err)
	}
	defer browser.close()

	if err := browser.run(nil, "open", "https://news.ycombinator.com/"); err != nil {
		log.Fatal(err)
	}
	schema := `{"rows": "tr.athing", "fields": {"rank": ".rank", "title": ".titleline > a"}, "limit": 10}`
	var extracted struct {
		Rows []struct {
			Rank  string `json:"rank"`
			Title string `json:"title"`
		} `json:"rows"`
	}
	if err := browser.run(&extracted, "extract", schema, "--inline"); err != nil {
		log.Fatal(err)
	}
	for _, story := range extracted.Rows {
		fmt.Println(story.Rank, story.Title)
	}
}
