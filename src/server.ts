import http from "node:http";

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, {"content-type": "application/json"});
    response.end(JSON.stringify({status: "ok"}));
    return;
  }
  response.writeHead(404, {"content-type": "application/json"});
  response.end(JSON.stringify({error: "not_found"}));
});

server.listen(8080, "0.0.0.0");
