import React from "react";

class Legacy extends React.Component {
  render() {
    return <>{this.props.children}</>;
  }
}

export default function Wrapped() {
  return (
    <Legacy>
      <span>child</span>
    </Legacy>
  );
}
