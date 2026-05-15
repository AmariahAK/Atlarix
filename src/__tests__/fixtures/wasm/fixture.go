package main

import "fmt"

type Server struct {
	Port int
}

func (s *Server) Listen() {
	fmt.Println(s.Port)
}

func main() {
	s := Server{Port: 8080}
	s.Listen()
}
